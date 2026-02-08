const express = require('express');
const admin = require("firebase-admin");
const cors = require('cors');
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE ADMIN SETUP ---
try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_KEY, "base64").toString("utf-8");
    const serviceAccount = JSON.parse(decoded);
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    }
    console.log("✅ Firebase Admin Initialized");
} catch (error) {
    console.error("❌ Firebase Admin Init Error:", error.message);
}

// --- JWT VERIFICATION MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send({ message: 'unauthorized access' });
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'unauthorized access' });
        }
        req.decoded = decoded;
        next();
    });
};

// MONGO Connection
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
    serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run() {
    try {
        await client.connect();
        const db = client.db("etuitionBD");
        const tutionsCollection = db.collection("tuitions");
        const usersCollectin = db.collection("users");
        const appicationsCollection = db.collection("applications");
        const paymentsCollection = db.collection("payments");

        // --- AUTH/JWT API ---
        app.post('/jwt', async (req, res) => {
            const user = req.body;
            const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '1h' });
            res.send({ token });
        });

        // --- USER STATS API (FIXED FOR TUTOR STATS) ---
        app.get('/user-stats/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const user = await usersCollectin.findOne({ email: email });
            let stats = {};

            if (user?.role === 'admin') {
                const totalUsers = await usersCollectin.countDocuments();
                const totalTuitions = await tutionsCollection.countDocuments();
                const allPayments = await paymentsCollection.find().toArray();
                const earnings = allPayments.reduce((sum, payment) => sum + parseFloat(payment.salary || 0), 0);
                stats = { totalUsers, totalTuitions, earnings };
            } 
            else if (user?.role === 'tutor') {
                // Count all applications
                const applications = await appicationsCollection.countDocuments({ tutorEmail: email });
                
                // FIXED: Calculate ongoing tuitions (where status is 'paid')
                const ongoingTuitions = await appicationsCollection.countDocuments({ 
                    tutorEmail: email, 
                    status: 'paid' 
                });

                // FIXED: Calculate total earnings from paymentsCollection
                const tutorPayments = await paymentsCollection.find({ tutorEmail: email }).toArray();
                const totalEarnings = tutorPayments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);

                stats = { applications, ongoingTuitions, totalEarnings };
            } 
            else {
                const tuitions = await tutionsCollection.countDocuments({ studentEmail: email });
                const totalPaid = await paymentsCollection.countDocuments({ studentEmail: email });
                stats = { tuitions, totalPaid };
            }
            res.send({ user, stats });
        });

        // --- USERS & ROLE API ---
        app.get('/users', async (req, res) => {
            const result = await usersCollectin.find().toArray();
            res.send(result);
        });

        app.get('/users/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await usersCollectin.findOne(query);
            res.send(result);
        });

        app.get('/users/role/:email', async (req, res) => {
            const email = req.params.email;
            if (email === "admin@etuition.com") return res.send({ role: "admin" });
            const user = await usersCollectin.findOne({ email: email });
            res.send({ role: user?.role || 'student' });
        });

        app.post('/users', async (req, res) => {
            const newUser = req.body;
            const query = { email: newUser.email };
            const existingUser = await usersCollectin.findOne(query);
            if (existingUser) return res.send({ message: 'user already exists', insertedId: null });
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        app.patch('/users/role/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const userRole = req.body.role;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { role: userRole } };
            const result = await usersCollectin.updateOne(filter, updateDoc);
            res.send(result);
        });

        app.delete('/users/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await usersCollectin.deleteOne(query);
            res.send(result);
        });

        // --- ADMIN: MANAGE TUITIONS (PENDING FETCH) ---
        app.get('/admin/pending-tuitions', verifyToken, async (req, res) => {
            const query = { status: 'pending' };
            const result = await tutionsCollection.find(query).toArray();
            res.send(result);
        });

        // --- ADMIN: UPDATE TUITION STATUS (APPROVE/REJECT) ---
        app.patch('/tuitions/status/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const status = req.body.status;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: { status: status },
            };
            const result = await tutionsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        // --- TUTOR ONGOING JOBS ---
        app.get('/tutor-ongoing/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) return res.status(403).send({ message: 'forbidden' });
            const query = { tutorEmail: email, status: 'paid' };
            const result = await appicationsCollection.find(query).toArray();
            res.send(result);
        });

        // --- ADD THIS TO YOUR SERVER.JS ---
        app.post('/hiring-requests', verifyToken, async (req, res) => {
            const application = req.body;
            const result = await appicationsCollection.insertOne(application);
            res.send(result);
        });

        // Add this to your backend server.js inside run()
        app.get('/hiring-requests-by-tutor/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { tutorEmail: email };
            const result = await appicationsCollection.find(query).toArray();
            res.send(result);
        });

        // server.js inside run()
        app.patch('/applications/status/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const status = req.body.status;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: { status: status },
            };
            const result = await appicationsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        // --- TUTOR REVENUE HISTORY API ---
        app.get('/tutor-revenue/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { tutorEmail: email };
            const payments = await paymentsCollection.find(query).sort({ date: -1 }).toArray();
            res.send(payments);
        });

        // Add this to your server.js inside the run() function
        app.delete('/applications/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await appicationsCollection.deleteOne(query);
            res.send(result);
        });

        // --- HIRING REQUESTS BY STUDENT EMAIL ---
        app.get('/hiring-requests-by-student/:email', async (req, res) => {
            const email = req.params.email;
            const query = { studentEmail: email };
            const result = await appicationsCollection.find(query).toArray();
            res.send(result);
        });

        // --- TUITION MANAGEMENT (USER SIDE - APPLICATIONS) ---
        app.delete('/cancel-tuition/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const result = await appicationsCollection.deleteOne({ _id: new ObjectId(id) });
            res.send(result);
        });

        app.patch('/update-tuition/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const updatedData = req.body;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = {
                $set: { subject: updatedData.subject, salary: updatedData.salary },
            };
            const result = await appicationsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });

        // --- TUITIONS CORE API ---
        app.get('/tuitions', async (req, res) => {
            const email = req.query.email;
            let query = email ? { studentEmail: email } : { status: 'approved' };
            const result = await tutionsCollection.find(query).sort({ postedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/tuition/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tutionsCollection.findOne(query);
            res.send(result);
        });

        app.post('/tuitions', verifyToken, async (req, res) => {
            const result = await tutionsCollection.insertOne(req.body);
            res.send(result);
        });

        // --- FIXED: TUITION POST DELETE & UPDATE (FOR MY POSTS PAGE) ---
        app.delete('/tuitions/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await tutionsCollection.deleteOne(query);
            res.send(result);
        });

        app.patch('/tuitions/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: new ObjectId(id) };
            const updatedDoc = {
                $set: {
                    subject: req.body.subject,
                    class: req.body.class,
                    salary: parseFloat(req.body.salary),
                    location: req.body.location
                }
            };
            const result = await tutionsCollection.updateOne(filter, updatedDoc);
            res.send(result);
        });

        // --- STUDENT EXPENSE HISTORY API ---
        app.get('/student-expenses/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            if (email !== req.decoded.email) {
                return res.status(403).send({ message: 'forbidden access' });
            }
            const query = { studentEmail: email };
            // Fetch all payments made by this student
            const expenses = await paymentsCollection.find(query).sort({ date: -1 }).toArray();
            res.send(expenses);
        });

        // --- UNIFIED ONGOING JOBS FETCH ---
        app.get('/ongoing-tuitions/:email', verifyToken, async (req, res) => {
            const email = req.params.email;
            const role = req.query.role; // Pass role from frontend
            
            if (email !== req.decoded.email) return res.status(403).send({ message: 'forbidden' });

            let query = { status: 'paid' };
            if (role === 'tutor') {
                query.tutorEmail = email;
            } else {
                query.studentEmail = email;
            }

            const result = await appicationsCollection.find(query).toArray();
            res.send(result);
        });

        app.get('/admin/analytics', verifyToken, async (req, res) => {
            const totalUsers = await usersCollectin.countDocuments();
            const payments = await paymentsCollection.find().toArray();
            
            // Calculate platform revenue: 10% from Student + 10% from Tutor = 20% total per transaction
            const totalVolume = payments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
            const platformRevenue = totalVolume * 0.20; 

            res.send({
                totalUsers,
                totalVolume,
                platformRevenue,
                payments
            });
        });

        // --- TERMINATE CONTRACT & NOTIFY ---
        app.delete('/terminate-contract/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const { tutorEmail, studentEmail, subject } = req.body;

            const query = { _id: new ObjectId(id) };
            const deleteResult = await appicationsCollection.deleteOne(query);

            if (deleteResult.deletedCount > 0) {
                // Log notification in a collection (Optional: you can create a 'notifications' collection)
                const notification = {
                    receiverEmail: tutorEmail,
                    senderEmail: studentEmail,
                    message: `Contract for ${subject} was terminated by the student.`,
                    type: 'termination',
                    date: new Date()
                };
                await db.collection("notifications").insertOne(notification);
            }
            res.send(deleteResult);
        });

        // --- STRIPE & PAYMENTS ---
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            try {
                const { salary } = req.body;
                const amount = Math.round(parseFloat(salary) * 100);
                if (!amount || amount < 1) return res.status(400).send({ message: "Invalid amount" });

                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount,
                    currency: "usd",
                    payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                console.error("Payment Intent Error:", error);
                res.status(500).send({ message: "Failed to create payment intent" });
            }
        });

        app.post("/payments", verifyToken, async (req, res) => {
            try {
                const payment = req.body;
                const paymentResult = await paymentsCollection.insertOne(payment);
                
                if (payment.appId) {
                    const query = { _id: new ObjectId(payment.appId) };
                    const updateDoc = { $set: { status: "paid" } };
                    await appicationsCollection.updateOne(query, updateDoc);
                }
                
                res.send({ paymentResult });
            } catch (error) {
                console.error("Payment Save Error:", error);
                res.status(500).send({ message: "Failed to save payment" });
            }
        });

        console.log("🚀 MongoDB Connected & Routes Fully Secured");
    } finally { }
}
run().catch(console.dir);

app.get('/', (req, res) => res.send("eTuition Server Running"));
app.listen(port, () => console.log(`Server port: ${port}`));