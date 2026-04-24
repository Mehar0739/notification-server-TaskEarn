const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

const app = express();
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

app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
