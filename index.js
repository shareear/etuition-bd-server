const express = require('express');
const admin = require("firebase-admin");
const cors = require('cors');
const port = process.env.PORT || 3000;
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// middlewares:
const app = express();
app.use(cors());
app.use(express.json());

// MONGO Connections start:
const uri = process.env.MONGO_URI;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// firebase admin setup:
const serviceAccount = require("./etuition-bd-firebase-sdk.json");
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

async function run(){
    try{
        await client.connect();
        
        const db = client.db("etuitionBD");
        const tutionsCollection = db.collection("tuitions");
        const usersCollectin = db.collection("users");
        const appicationsCollection = db.collection("applications");
        const paymentsCollection = db.collection("payments");

        // --- USERS & ADMIN MANAGEMENT API ---
        app.get('/users', async(req, res)=>{
            const result = await usersCollectin.find().toArray();
            res.send(result);
        });

        app.get('/users/role/:email', async(req, res)=>{
            const email = req.params.email;
            if(email === "admin@etuition.com"){
                return res.send({role: "admin"});
            };
            const user = await usersCollectin.findOne({email: email});
            res.send({role: user?.role || 'student'});
        });

        app.post('/users', async(req, res)=>{
            const newUser = req.body;
            const query = {email: newUser.email}
            const existingUser = await usersCollectin.findOne(query);
            if(existingUser){
                return res.send({message: 'user already exists', insertedId: null});
            };
            const result = await usersCollectin.insertOne(newUser);
            res.send(result);
        });

        app.patch('/users/role/:id', async (req, res) => {
            const id = req.params.id;
            const { role } = req.body;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { role: role } };
            const result = await usersCollectin.updateOne(filter, updateDoc);
            res.send(result);
        });

        app.delete('/users/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await usersCollectin.deleteOne(query);
            res.send(result);
        });


        // --- TUITIONS API ---
        app.get('/tuitions', async(req, res)=>{
            try {
                const email = req.query.email;
                let query = {};
                if(email) query = { studentEmail: email };
                const result = await tutionsCollection.find(query).sort({ postedDate: -1 }).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Internal Server Error" });
            }
        });

        app.get('/admin/pending-tuitions', async (req, res) => {
            try {
                const query = { status: 'pending' };
                const result = await tutionsCollection.find(query).toArray();
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Server error" });
            }
        });

        app.get('/tuition/:id', async (req, res) => {
            try {
                const id = req.params.id;
                if (!ObjectId.isValid(id)) return res.status(400).send({ message: "Invalid ID" });
                const result = await tutionsCollection.findOne({ _id: new ObjectId(id) });
                res.send(result);
            } catch (error) {
                res.status(500).send({ message: "Server error" });
            }
        });

        app.post('/tuitions', async(req, res)=>{
            const newTuition = req.body;
            newTuition.status = 'pending';
            const result = await tutionsCollection.insertOne(newTuition);
            res.send(result);
        });

        app.patch('/tuitions/status/:id', async(req, res)=>{
            const id = req.params.id;
            const {status} = req.body;
            const filter= {_id: new ObjectId(id)};
            const updateDoc = { $set: {status: status} };
            const result = await tutionsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });


        // --- APPLICATION API ---
        app.post('/applications', async (req, res) => {
            const application = req.body;
            const query = { tutorEmail: application.tutorEmail, studentEmail: application.studentEmail };
            const alreadyApplied = await appicationsCollection.findOne(query);
            if (alreadyApplied) {
                return res.status(400).send({ message: 'You have already sent a request to this tutor!', insertedId: null });
            }
            application.status = 'Pending';
            application.appliedDate = new Date().toISOString();
            const result = await appicationsCollection.insertOne(application);
            res.send(result);
        });

        // 1. New Route for Students to see their specific requests
        app.get('/hiring-requests-by-student/:email', async (req, res) => {
            const email = req.params.email;
            const query = { studentEmail: email };
            const result = await appicationsCollection.find(query).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.get('/hiring-requests/:email', async (req, res) => {
            const email = req.params.email;
            const query = { tutorEmail: email };
            const result = await appicationsCollection.find(query).sort({ appliedDate: -1 }).toArray();
            res.send(result);
        });

        app.patch('/hiring-requests/status/:id', async (req, res) => {
            const id = req.params.id;
            const { status } = req.body;
            const filter = { _id: new ObjectId(id) };
            const updateDoc = { $set: { status: status } };
            const result = await appicationsCollection.updateOne(filter, updateDoc);
            res.send(result);
        });


        // --- PAYMENT & STRIPE ---
        app.post("/create-payment-intent", async (req, res) => {
            const { salary } = req.body;
            if (!salary) return res.status(400).send({ message: "Salary missing" });
            const amount = parseInt(parseFloat(salary) * 100);
            try {
                const paymentIntent = await stripe.paymentIntents.create({
                    amount: amount, currency: "usd", payment_method_types: ["card"],
                });
                res.send({ clientSecret: paymentIntent.client_secret });
            } catch (error) {
                res.status(500).send({ error: error.message });
            }
        });

        // Updated Payment Route to set status as 'paid'
        app.post("/payments", async (req, res) => {
            const payment = req.body;
            const paymentResult = await paymentsCollection.insertOne(payment);
            const filter = { _id: new ObjectId(payment.appId) };
            const updateDoc = { $set: { status: "paid" } }; // Status becomes 'paid' after transaction
            const updateResult = await appicationsCollection.updateOne(filter, updateDoc);
            res.send({ paymentResult, updateResult });
        });


        // --- TUTOR ANALYTICS & ONGOING ---
        app.get('/tutor-ongoing/:email', async (req, res) => {
            const email = req.params.email;
            // A job is ongoing only if it is paid
            const result = await appicationsCollection.find({ tutorEmail: email, status: 'paid' }).toArray();
            res.send(result);
        });

        app.get('/tutor-revenue/:email', async (req, res) => {
            const email = req.params.email;
            const payments = await paymentsCollection.find({ tutorEmail: email }).toArray();
            const totalRevenue = payments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
            res.send({ totalRevenue, payments });
        });


        // --- ANALYTICS & STATS ---
        app.get('/admin/analytics', async (req, res) => {
            const payments = await paymentsCollection.find().toArray();
            const totalEarnings = payments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
            res.send({ totalEarnings, transactionCount: payments.length, payments });
        });

        app.get('/admin-stats', async (req, res) => {
            const usersCount = await usersCollectin.countDocuments();
            const tutorsCount = await usersCollectin.countDocuments({role: 'tutor'});
            const studentsCount = await usersCollectin.countDocuments({role: 'student'});
            const totalJobs = await tutionsCollection.countDocuments();
            const payments = await paymentsCollection.find().toArray();
            const totalRevenue = payments.reduce((sum, p) => sum + parseFloat(p.salary || 0), 0);
            res.send({ totalUsers: usersCount, tutors: tutorsCount, students: studentsCount, totalJobs, totalRevenue });
        });

        app.get('/user-stats/:email', async (req, res) => {
            const email = req.params.email;
            const user = await usersCollectin.findOne({ email: email });
            if (!user) return res.status(404).send({ message: "User not found" });

            let stats = {};
            if (user.role === 'admin') {
                stats = { totalUsers: await usersCollectin.countDocuments(), totalTuitions: await tutionsCollection.countDocuments() };
            } else if (user.role === 'tutor') {
                stats = { 
                    totalApplied: await appicationsCollection.countDocuments({ tutorEmail: email }),
                    ongoingTuitions: await appicationsCollection.countDocuments({ tutorEmail: email, status: 'paid' })
                };
            } else {
                stats = { myPosts: await tutionsCollection.countDocuments({ studentEmail: email }), totalSpent: 0 };
            }
            res.send({ user, stats });
        });

        // --- CANCEL/DELETE TUITION ---
        app.delete('/cancel-tuition/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: new ObjectId(id) };
            const result = await appicationsCollection.deleteOne(query);
            res.send(result);
        });

        await client.db("admin").command({ping: 1});
        console.log("MongoDB Connected and Ready!");
    } finally{}
}

run().catch(console.dir);

app.get('/', (req, res)=> res.send("eTuition Server Running"));
app.listen(port, ()=> console.log(`Server port: ${port}`));