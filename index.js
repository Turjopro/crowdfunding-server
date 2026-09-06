const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r6qfvfv.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();

    const db = client.db('crowdfundingDB');
    const usersCollection = db.collection('users');
    const campaignsCollection = db.collection('campaigns');
    const contributionsCollection = db.collection('contributions');
    const withdrawalsCollection = db.collection('withdrawals');
    const notificationsCollection = db.collection('notifications');
    const paymentsCollection = db.collection('payments');
    const reportsCollection = db.collection('reports');

    app.get('/', (req, res) => {
      res.send('Crowdfunding server is running');
    });

    // JWT related API
    app.post('/jwt', async (req, res) => {
      const user = req.body; // { email: user.email }
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.send({ token });
    });

    // Register a new user
    app.post('/users', async (req, res) => {
      const user = req.body;

      const existingUser = await usersCollection.findOne({ email: user.email });
      if (existingUser) {
        return res.status(400).send({ message: 'User already exists', insertedId: null });
      }

      if (user.role === 'supporter') {
        user.credits = 50;
      } else if (user.role === 'creator') {
        user.credits = 20;
      } else {
        user.credits = 0;
      }

      user.createdAt = new Date();

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // Get a single user by email
    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } catch (err) {
    console.error(err);
  }
}
run();

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});