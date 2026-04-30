const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
const port = process.env.PORT || 3000;

// Fix private key formatting from .env
const privateKey = process.env.FIREBASE_PRIVATE_KEY
    ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
    : undefined;

// Initialize Firebase
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: privateKey,
        })
    });
}

const db = admin.firestore();
const startupTime = new Date();

const sendNotification = async (title, message) => {
    try {
        const response = await axios.post(
            'https://onesignal.com/api/v1/notifications',
            {
                app_id: process.env.ONESIGNAL_APP_ID,
                // Server directly targets your Email
                filters: [
                    { "field": "tag", "key": "email", "relation": "=", "value": process.env.ADMIN_EMAIL }
                ],
                headings: { en: title },
                contents: { en: message }
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`
                }
            }
        );
        console.log("OneSignal Notification Sent! Response:", response.data);
    } catch (error) {
        console.error("OneSignal Error:", error.response ? JSON.stringify(error.response.data) : error.message);
    }
};

console.log(`Notification Server starting up... Startup Time: ${startupTime}`);
console.log(`Target Admin Email: ${process.env.ADMIN_EMAIL}`);

// Listen to Transactions (Deposits / Withdrawals)
console.log("Initializing Firestore listeners...");
db.collection('transactions').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        console.log(`Snapshot received: ${snapshot.size} pending transactions found.`);
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const docId = change.doc.id;
                
                // Only process if we haven't notified already
                if (!data.notified) {
                    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
                    console.log(`[TX] New Pending found: ${docId}. Type: ${data.type}. Created: ${createdAt}`);

                    if (createdAt >= startupTime) {
                        console.log(`[TX] Sending push for ${docId}...`);
                        if (data.type === 'Recharge') {
                            sendNotification('New Deposit Request', `User requested a deposit of ${data.amount} USDT.`);
                        } else if (data.type === 'Withdrawal') {
                            sendNotification('New Withdrawal Request', `User requested a withdrawal of ${data.amount} USDT.`);
                        }
                    } else {
                        console.log(`[TX] Skipping push for old transaction ${docId} (Created before startup).`);
                    }
                    
                    change.doc.ref.update({ notified: true })
                        .then(() => console.log(`[TX] Marked ${docId} as notified.`))
                        .catch(err => console.error(`[TX] Failed to mark ${docId}:`, err));
                }
            }
        });
    }, (err) => console.error("Firestore Listener Error (Transactions):", err));

// Listen to Support Tickets
db.collection('tickets').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const docId = change.doc.id;
                
                if (!data.notified) {
                    const createdAt = data.createdAt?.toDate ? data.createdAt.toDate() : new Date();
                    console.log(`[Ticket] New Pending found: ${docId}. Created: ${createdAt}`);

                    if (createdAt >= startupTime) {
                        console.log(`[Ticket] Sending push for ${docId}...`);
                        sendNotification('New Support Ticket', `A user just sent a message.`);
                    } else {
                        console.log(`[Ticket] Skipping push for old ticket ${docId}.`);
                    }

                    change.doc.ref.update({ notified: true })
                        .then(() => console.log(`[Ticket] Marked ${docId} as notified.`))
                        .catch(err => console.error(`[Ticket] Failed to mark ${docId}:`, err));
                }
            }
        });
    }, (err) => console.error("Firestore Listener Error (Tickets):", err));

// Keep-alive and Test route
app.get('/', (req, res) => {
    res.send(`
        <h1>Notification Server is Active! 🟢</h1>
        <p>Startup Time: ${startupTime}</p>
        <p>Admin Email: ${process.env.ADMIN_EMAIL}</p>
        <hr>
        <a href="/test-notification" style="padding: 10px 20px; background: gold; border-radius: 5px; text-decoration: none; color: black; font-weight: bold;">
            Send Test Notification
        </a>
    `);
});

app.get('/test-notification', async (req, res) => {
    console.log("Manual test notification triggered via browser...");
    try {
        await sendNotification('System Test', 'OneSignal connection is working! If you see this, the server is configured correctly.');
        res.send("<h1>Test Notification Triggered!</h1><p>Check your phone/browser and Render logs.</p><a href='/'>Go Back</a>");
    } catch (e) {
        res.status(500).send(`Error: ${e.message}`);
    }
});

const OXAPAY_API_URL = 'https://api.oxapay.com/merchants/request';

// Endpoint to create an OxaPay payment request
app.post('/api/payment/oxapay/create-order', async (req, res) => {
    const { amount, userId, userEmail } = req.body;

    if (!amount || !userId) {
        return res.status(400).json({ error: 'Amount and User ID are required' });
    }

    try {
        const secretsRef = db.collection('settings').doc('secrets');
        const secretsSnap = await secretsRef.get();

        if (!secretsSnap.exists) {
            return res.status(500).json({ error: 'Payment gateway not configured' });
        }

        const secrets = secretsSnap.data();
        const apiKey = secrets.oxapayApiKey;

        if (!apiKey) {
            return res.status(500).json({ error: 'OxaPay API Key missing in Admin Settings' });
        }

        const orderId = `ORDER_${Date.now()}_${userId.slice(0, 5)}`;

        const payload = {
            merchant: apiKey,
            amount: parseFloat(amount),
            currency: 'USDT', // Defaulting to USDT, OxaPay will handle selection
            lifeTime: 30, // 30 minutes
            feePaidByPayer: 1,
            underPaidAction: 'take',
            description: `Deposit for ${userEmail || userId}`,
            orderId: orderId,
            email: userEmail || '',
            callbackUrl: `${req.protocol}://${req.get('host')}/api/payment/oxapay/webhook`,
            returnUrl: req.headers.origin || "https://taskearn.vip",
        };

        const response = await axios.post(OXAPAY_API_URL, payload);

        if (response.data.result === 100) {
            // Log the pending transaction in Firestore
            await db.collection('transactions').add({
                userId,
                userEmail,
                type: 'Recharge',
                network: 'OxaPay',
                amount: parseFloat(amount),
                status: 'Pending',
                trackId: response.data.trackId,
                orderId: orderId,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });

            res.json({ payUrl: response.data.payLink });
        } else {
            console.error("OxaPay API Error:", response.data);
            res.status(400).json({ error: response.data.message || 'OxaPay Error' });
        }

    } catch (error) {
        console.error("OxaPay Order Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: 'Failed to create OxaPay order' });
    }
});

// OxaPay Webhook Handler with Security Verification
app.post('/api/payment/oxapay/webhook', async (req, res) => {
    const receivedSignature = req.headers['hmac'];
    const { trackId, orderId, status, amount, payAmount } = req.body;

    console.log(`OxaPay Webhook received: Order ${orderId}, Status ${status}`);

    try {
        // 1. Fetch the API Key from secrets
        const secretsRef = db.collection('settings').doc('secrets');
        const secretsSnap = await secretsRef.get();
        if (!secretsSnap.exists) return res.sendStatus(500);

        const apiKey = secretsSnap.data().oxapayApiKey;

        // 2. Verify the HMAC Signature
        // OxaPay sends HMAC of the raw body using the API Key as secret
        const payload = JSON.stringify(req.body);
        const calculatedSignature = crypto
            .createHmac('sha512', apiKey)
            .update(payload)
            .digest('hex');

        if (receivedSignature !== calculatedSignature) {
            console.warn("Invalid HMAC signature received! Possible attack.");
            return res.status(401).send('Unauthorized');
        }

        // 3. Process the payment if verified and status is Paid
        if (status === 'Paid' || status === 'Success') {
            // Find the transaction in Firestore
            const txQuery = await db.collection('transactions')
                .where('orderId', '==', orderId)
                .where('status', '==', 'Pending')
                .limit(1)
                .get();

            if (!txQuery.empty) {
                const txDoc = txQuery.docs[0];
                const txData = txDoc.data();
                const userId = txData.userId;

                // Update transaction status
                await txDoc.ref.update({
                    status: 'Completed',
                    paidAmount: payAmount,
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // Credit user balance
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    rechargeBalance: admin.firestore.FieldValue.increment(parseFloat(amount))
                });

                console.log(`Successfully credited ${amount} USDT to User ${userId}`);
            }
        }

        // Respond with 'ok' as required by OxaPay
        res.status(200).send('ok');

    } catch (error) {
        console.error("Webhook Processing Error:", error);
        res.status(500).send('Internal Server Error');
    }
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
