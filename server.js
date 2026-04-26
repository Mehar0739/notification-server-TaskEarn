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
                    {"field": "tag", "key": "email", "relation": "=", "value": process.env.ADMIN_EMAIL}
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
        console.log("Notification sent successfully!");
    } catch (error) {
        console.error("Error sending notification:", error.response ? error.response.data : error.message);
    }
};

// Listen to Transactions (Deposits / Withdrawals)
db.collection('transactions').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
                
                if (createdAt >= startupTime) {
                    if (data.type === 'Recharge') {
                        sendNotification('New Deposit Request', `User requested a deposit of ${data.amount} USDT.`);
                    } else if (data.type === 'Withdrawal') {
                        sendNotification('New Withdrawal Request', `User requested a withdrawal of ${data.amount} USDT.`);
                    }
                }
            }
        });
    });

// Listen to Support Tickets
db.collection('tickets').where('status', '==', 'Pending')
    .onSnapshot((snapshot) => {
        snapshot.docChanges().forEach((change) => {
            if (change.type === 'added') {
                const data = change.doc.data();
                const createdAt = data.createdAt ? data.createdAt.toDate() : new Date();
                
                if (createdAt >= startupTime) {
                    sendNotification('New Support Ticket', `A user just sent a message.`);
                }
            }
        });
    });

// Keep-alive route
app.get('/', (req, res) => {
    res.send('Notification Server is Active! 🟢');
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
            returnUrl: req.headers.origin || "https://your-site.com",
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

// OxaPay Webhook Handler
app.post('/api/payment/oxapay/webhook', async (req, res) => {
    const { trackId, orderId, status, amount, payAmount } = req.body;

    console.log(`OxaPay Webhook received: Order ${orderId}, Status ${status}`);

    if (status === 'Paid' || status === 'Success') {
        try {
            // 1. Find the transaction in Firestore
            const txQuery = await db.collection('transactions')
                .where('orderId', '==', orderId)
                .where('status', '==', 'Pending')
                .limit(1)
                .get();

            if (!txQuery.empty) {
                const txDoc = txQuery.docs[0];
                const txData = txDoc.data();
                const userId = txData.userId;

                // 2. Update transaction status
                await txDoc.ref.update({
                    status: 'Completed',
                    paidAmount: payAmount,
                    completedAt: admin.firestore.FieldValue.serverTimestamp()
                });

                // 3. Credit user balance
                const userRef = db.collection('users').doc(userId);
                await userRef.update({
                    rechargeBalance: admin.firestore.FieldValue.increment(parseFloat(amount))
                });

                console.log(`Successfully credited ${amount} USDT to User ${userId}`);
            }
        } catch (error) {
            console.error("Webhook Processing Error:", error);
        }
    }

    // Always respond with 200 to OxaPay
    res.sendStatus(200);
});

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
