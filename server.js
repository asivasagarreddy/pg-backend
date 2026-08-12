require('dotenv').config();
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// ----------------------------------------------------
// ROUTE 1: Create a New Tenant
// ----------------------------------------------------
app.post('/api/tenants', async (req, res) => {
    const { name, phone, email } = req.body;
    const { data, error } = await supabase.from('tenants').insert([{ name, phone, email }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: 'Tenant successfully added', tenant: data[0] });
});

// ----------------------------------------------------
// ROUTE 2: Manual Payment Logging
// ----------------------------------------------------
app.post('/api/transactions', async (req, res) => {
    const { invoice_id, amount_paid, payment_mode, transaction_reference } = req.body;
    const { data, error } = await supabase.from('transactions').insert([{ invoice_id, amount_paid, payment_mode, transaction_reference }]).select();
    if (error) return res.status(400).json({ error: error.message });
    res.status(201).json({ message: 'Payment logged', transaction: data[0] });
});

// ----------------------------------------------------
// ROUTE 3: Automated Tasker SMS Webhook
// ----------------------------------------------------
app.post('/api/webhook/sms', async (req, res) => {
    const { sender, text } = req.body;

    if (!text || !text.toLowerCase().includes('credited')) {
        return res.status(200).json({ message: 'Ignored: Not a credit SMS' });
    }

    const amountMatch = text.match(/(?:Rs\.?|INR)\s*([\d,]+\.?\d*)/i);
    const utrMatch = text.match(/(?:UPI|UTR|Ref(?:\.?\s*No\.?)?|RRN|IMPS)[\s:-]*([0-9]{12})/i);
    const noteMatch = text.match(/(?:Note|Remark|Msg|Message)[\s:-]*([a-zA-Z0-9_-]+)/i);

    if (!amountMatch || !utrMatch) {
        return res.status(200).json({ message: 'Ignored: Could not parse amount or UTR' });
    }

    const amountPaid = parseFloat(amountMatch[1].replace(/,/g, ''));
    const utr = utrMatch[1];
    const customNote = noteMatch ? noteMatch[1] : null;

    try {
        let invoiceId = customNote ? customNote : null; 

        // FALLBACK: Match by exact amount if Note is missing
        if (!invoiceId) {
            const { data: matchingInvoices, error: matchError } = await supabase
                .from('invoices')
                .select('invoice_id')
                .eq('status', 'Unpaid')
                .eq('amount_due', amountPaid);

            if (matchError) throw matchError;

            if (matchingInvoices && matchingInvoices.length === 1) {
                invoiceId = matchingInvoices[0].invoice_id;
                console.log(`⚡ Auto-matched UTR ${utr} to Invoice ${invoiceId} based on exact amount.`);
            } else if (matchingInvoices && matchingInvoices.length > 1) {
                console.log(`⚠️ Collision: ${matchingInvoices.length} tenants owe ₹${amountPaid}. UTR ${utr} requires manual assignment.`);
            } else {
                console.log(`⚠️ No unpaid invoices found for exactly ₹${amountPaid}.`);
            }
        }

        const { data: existingTxn } = await supabase
            .from('transactions')
            .select('transaction_id')
            .eq('transaction_reference', utr);

        if (existingTxn && existingTxn.length > 0) {
            return res.status(200).json({ message: 'Ignored: Duplicate UTR already logged' });
        }

        const { data, error } = await supabase
            .from('transactions')
            .insert([{ invoice_id: invoiceId, amount_paid: amountPaid, payment_mode: 'UPI', transaction_reference: utr }])
            .select();

        if (error) throw error;
        
        console.log(`✅ Automated Payment Logged: ₹${amountPaid} (UTR: ${utr})`);
        return res.status(201).json({ message: 'Payment successfully reconciled', data: data[0] });

    } catch (err) {
        console.error('Database error:', err.message);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

const PORT = process.env.PORT || 3000;

const cron = require('node-cron');

// ----------------------------------------------------
// AUTOMATED BILLING ENGINE (Runs at 00:00 on the 1st of every month)
// ----------------------------------------------------
cron.schedule('0 0 1 * *', async () => {
    console.log('⏳ Running monthly invoice generation...');
    
    // 1. Define the billing cycle
    const now = new Date();
    const currentMonth = now.getMonth() + 1; // JS months are 0-11
    const currentYear = now.getFullYear();
    
    // Set due date to the 5th of the current month
    const dueDate = new Date(currentYear, currentMonth - 1, 5).toISOString().split('T')[0];

    try {
        // 2. Find all active leases
        const { data: activeLeases, error: leaseError } = await supabase
            .from('leases')
            .select('lease_id, agreed_monthly_rent')
            .eq('status', 'Active');

        if (leaseError) throw leaseError;

        let generatedCount = 0;

        // 3. Process each lease safely
        for (const lease of activeLeases) {
            
            // SAFETY CHECK: Ensure we haven't already billed this lease for this month
            // We look for an invoice created in the current month & year
            const { data: existingInvoices } = await supabase
                .from('invoices')
                .select('invoice_id')
                .eq('lease_id', lease.lease_id)
                .eq('type', 'Rent')
                .gte('created_at', `${currentYear}-${currentMonth.toString().padStart(2, '0')}-01T00:00:00Z`);

            if (existingInvoices && existingInvoices.length === 0) {
                // Generate the new invoice
                await supabase
                    .from('invoices')
                    .insert([{
                        lease_id: lease.lease_id,
                        type: 'Rent',
                        amount_due: lease.agreed_monthly_rent,
                        due_date: dueDate,
                        status: 'Unpaid'
                    }]);
                generatedCount++;
            }
        }
        console.log(`✅ Billing complete. Generated ${generatedCount} new invoices.`);
    } catch (err) {
        console.error('❌ Billing Engine Error:', err.message);
    }
});

app.listen(PORT, () => {
    console.log(`🚀 PG Backend running on http://localhost:${PORT}`);
});