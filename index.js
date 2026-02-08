const express = require('express');
const admin = require("firebase-admin");
const cors = require('cors');
const jwt = require('jsonwebtoken'); // Added JWT
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// middlewares:
const app = express();
app.use(cors());
app.use(express.json());

// --- FIREBASE ADMIN SETUP ---
const decoded = Buffer.from(process.env.FIREBASE_SERVICE_KEY, "base64").toString("utf-8");
const serviceAccount = JSON.parse(decoded);
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

// --- JWT & AUTH MIDDLEWARE ---
const verifyToken = (req, res, next) => {
    if (!req.headers.authorization) {
        return res.status(401).send({ message: 'unauthorized access' });
    }
    const token = req.headers.authorization.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
        if (err) {
            return res.status(401).send({ message: 'unauthorized access' });
        }
        req.decoded = decoded;
        next();
    });
};

// MONGO Connections start:
const uri = process.env.MONGO_URI;
const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

async function run(){
    try{
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

        // --- USERS & ADMIN MANAGEMENT API ---
        app.get('/users', verifyToken, async(req, res)=>{
            const result = await usersCollectin.find().toArray();
            res.send(result);
        });

        app.get('/users/role/:email', async(req, res)=>{
            const email = req.params.email;
            if(email === "admin@etuition.com") return res.send({role: "admin"});
            const user = await usersCollectin.findOne({email: email});
            res.send({role: user?.role || 'student'});
        });

        app.post('/users', async(req, res)=>{
            const newUser = req.body;
            const query = {email: newUser.email}
            const existingUser = await usersCollectin.findOne(query);
            if(existingUser) return res.send({message: 'user already exists', insertedId: null});
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        app.patch('/users/role/:id', verifyToken, async (req, res) => {
            const id = req.params.id;
            const { role } = req.body;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { role: role } };
            const result = await usersCollectin.updateOne(filter, updateDoc);
            res.send(result);
        });

        app.delete('/users/:id', verifyToken, async (req, res) => {
            const result = await usersCollectin.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        // --- TUITIONS API ---
        app.get('/tuitions', async(req, res)=>{
            const email = req.query.email;
            let query = email ? { studentEmail: email } : {};
            const result = await tutionsCollection.find(query).sort({ postedDate: -1 }).toArray();
            res.send(result);
        });

        app.post('/tuitions', verifyToken, async(req, res)=>{
            const newTuition = req.body;
            newTuition.status = 'pending';
            const result = await tutionsCollection.insertOne(newTuition);
            res.send(result);
        });

        // --- APPLICATION API ---
        app.post('/applications', verifyToken, async (req, res) => {
            const application = req.body;
            
            // Critical Fix: Ensure subject and salary are saved from the job data
            if(!application.subject || !application.salary) {
                return res.status(400).send({ message: "Subject or Salary missing!" });
            }

            const query = { tutorEmail: application.tutorEmail, studentEmail: application.studentEmail, subject: application.subject };
            const alreadyApplied = await appicationsCollection.findOne(query);
            if (alreadyApplied) return res.status(400).send({ message: 'Already applied' });

            application.status = 'Pending';
            application.appliedDate = new Date().toISOString();
            const result = await appicationsCollection.insertOne(application);
            res.send(result);
        });

        app.get('/hiring-requests/:email', verifyToken, async (req, res) => {
            const result = await appicationsCollection.find({ tutorEmail: req.params.email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/hiring-requests-by-student/:email', verifyToken, async (req, res) => {
            const result = await appicationsCollection.find({ studentEmail: req.params.email }).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.patch('/hiring-requests/status/:id', verifyToken, async (req, res) => {
            const result = await appicationsCollection.updateOne(
                { _id: new ObjectId(req.params.id) }, 
                { $set: { status: req.body.status } }
            );
            res.send(result);
        });

        // --- PAYMENT & STRIPE (SENSITIVE) ---
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const { salary } = req.body;
            if (!salary || salary === "Negotiable") return res.status(400).send({ message: "Invalid amount" });
            const amount = Math.round(parseFloat(salary) * 100);
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount, currency: "usd", payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        app.post("/payments", verifyToken, async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne(payment);
            const filter = { _id: new ObjectId(payment.appId) };
            const updateResult = await appicationsCollection.updateOne(filter, { $set: { status: "paid" } });
            res.send({ paymentResult, updateResult });
        });

        // --- CANCEL/DELETE ---
        app.delete('/cancel-tuition/:id', verifyToken, async (req, res) => {
            const result = await appicationsCollection.deleteOne({ _id: new ObjectId(req.params.id) });
            res.send(result);
        });

        // --- PROFILES ---
        app.get('/student-profile/:id', async (req, res) => {
            const student = await usersCollectin.findOne({ _id: new ObjectId(req.params.id), role: 'student' });
            res.send(student || { message: "Not found" });
        });

        app.get('/tutor-profile/:id', async (req, res) => {
            const tutor = await usersCollectin.findOne({ _id: new ObjectId(req.params.id), role: 'tutor' });
            res.send(tutor || { message: "Not found" });
        });

    } finally{}
}

run().catch(console.dir);

app.get('/', (req, res)=> res.send("eTuition Server Running"));
app.listen(port, ()=> console.log(`Server port: ${port}`));