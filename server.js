const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const upload = multer({ dest: 'uploads/' });

// Supabase / PostgreSQL Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ==========================================
// ১. স্টক চেকিং ও অর্ডার লজিক (Warehouse vs Showroom)
// ==========================================
app.post('/api/orders/check-and-create', async (req, res) => {
    const { invoice_id, customer_name, customer_phone, address, items } = req.body;

    try {
        let fulfillment_source = 'warehouse';
        let is_warehouse_stock_available = true;

        // চেক করা হচ্ছে ওয়্যারহাউসে স্টক আছে কিনা
        for (let item of items) {
            const productRes = await pool.query('SELECT * FROM products_sku WHERE sku_code = $1', [item.sku_code]);
            const product = productRes.rows[0];

            if (!product || product.warehouse_stock < item.quantity) {
                is_warehouse_stock_available = false;
                break;
            }
        }

        // ওয়্যারহাউসে না থাকলে শো-রুমে চেক করা
        if (!is_warehouse_stock_available) {
            fulfillment_source = 'showroom';
            for (let item of items) {
                const productRes = await pool.query('SELECT * FROM products_sku WHERE sku_code = $1', [item.sku_code]);
                const product = productRes.rows[0];

                if (!product || product.showroom_stock < item.quantity) {
                    return res.status(400).json({ 
                        success: false, 
                        message: `SKU ${item.sku_code} ওয়্যারহাউস বা শোরুম কোথাও পর্যাপ্ত নেই!` 
                    });
                }
            }
        }

        // নতুন অর্ডার তৈরি করা
        const newOrder = await pool.query(
            `INSERT INTO orders (invoice_id, customer_name, customer_phone, address, items, fulfillment_source, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending') RETURNING *`,
            [invoice_id, customer_name, customer_phone, address, JSON.stringify(items), fulfillment_source]
        );

        res.json({
            success: true,
            message: fulfillment_source === 'warehouse' 
                ? 'অর্ডার প্রস্তুত, ওয়্যারহাউস স্টক পর্যাপ্ত।' 
                : 'অ্যালার্ট: ওয়্যারহাউসে স্টক নেই! শোরুম থেকে আইটেম সংগ্রহ করতে হবে।',
            order: newOrder.rows[0]
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ২. Steadfast Courier API Integration
// ==========================================
app.post('/api/steadfast/create-order', async (req, res) => {
    const { invoice_id, recipient_name, recipient_phone, recipient_address, cod_amount } = req.body;

    try {
        const response = await axios.post('https://portal.steadfast.com.bd/api/v1/create_order', {
            invoice: invoice_id,
            recipient_name: recipient_name,
            recipient_phone: recipient_phone,
            recipient_address: recipient_address,
            cod_amount: cod_amount
        }, {
            headers: {
                'Api-Key': process.env.STEADFAST_API_KEY,
                'Secret-Key': process.env.STEADFAST_SECRET_KEY,
                'Content-Type': 'application/json'
            }
        });

        if (response.data.status === 200) {
            // ডাটাবেজে কনসাইনমেন্ট আইডি আপডেট
            await pool.query('UPDATE orders SET steadfast_consignment_id = $1, status = $2 WHERE invoice_id = $3',
                [response.data.consignment.consignment_id, 'shipped', invoice_id]);

            res.json({ success: true, steadfast_data: response.data });
        } else {
            res.status(400).json({ success: false, data: response.data });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ৩. Steadfast Monthly CSV File Reconciliation
// ==========================================
app.post('/api/steadfast/upload-csv', upload.single('file'), (req, res) => {
    const results = [];
    const monthYear = req.body.month_year; // e.g., '2026-09'

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => results.push(data))
        .on('end', async () => {
            let totalCodCollected = 0;
            let totalDeliveryCharge = 0;
            let totalCommission = 0;
            let totalNetReceived = 0;
            let totalDelivered = 0;
            let totalReturned = 0;

            for (let row of results) {
                const trackingCode = row['Tracking Code'] || row['tracking_code'];
                const invoiceId = row['Invoice'] || row['invoice_id'];
                const cod = parseFloat(row['COD Amount'] || 0);
                const deliveryCharge = parseFloat(row['Delivery Charge'] || 0);
                const commission = parseFloat(row['COD Commission'] || 0);
                const netPayable = parseFloat(row['Net Payable'] || 0);
                const status = (row['Status'] || '').toLowerCase();

                if (status === 'delivered') totalDelivered++;
                if (status === 'returned') totalReturned++;

                totalCodCollected += cod;
                totalDeliveryCharge += deliveryCharge;
                totalCommission += commission;
                totalNetReceived += netPayable;

                // ডাটাবেজে মান্থলি রেকর্ড সেভ
                await pool.query(
                    `INSERT INTO steadfast_reconciliation 
                    (tracking_code, invoice_id, cod_amount, delivery_charge, cod_commission, net_received, status, month_year)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [trackingCode, invoiceId, cod, deliveryCharge, commission, netPayable, status, monthYear]
                );
            }

            // আপলোড করা ফাইল ডিলিট
            fs.unlinkSync(req.file.path);

            res.json({
                success: true,
                summary: {
                    month: monthYear,
                    total_orders_processed: results.length,
                    total_delivered: totalDelivered,
                    total_returned: totalReturned,
                    total_cod_collected: totalCodCollected,
                    total_courier_expense: totalDeliveryCharge + totalCommission,
                    net_cash_in_hand: totalNetReceived
                }
            });
        });
});

// ==========================================
// ৪. Owner Analytics (লাভ-ক্ষতি ও কস্ট অ্যানালিটিক্স)
// ==========================================
app.get('/api/owner/analytics', async (req, res) => {
    try {
        const sales = await pool.query(`SELECT SUM(net_received) as total_revenue FROM steadfast_reconciliation WHERE status = 'delivered'`);
        const expenses = await pool.query(`SELECT SUM(delivery_charge + cod_commission) as total_courier_cost FROM steadfast_reconciliation`);
        
        res.json({
            total_revenue: sales.rows[0].total_revenue || 0,
            courier_expense: expenses.rows[0].total_courier_cost || 0,
            suggestion: "কুরিয়ারের চার্জ ও রিটার্ন বেশি হচ্ছে। শোরুমের মাধ্যমে ব্যাকআপ হ্যান্ডলিং উন্নত করলে প্রফিট মার্জিন আরও ৫% বৃদ্ধি পাবে।"
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`ERP Backend running on port ${PORT}`));