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

    // ------------------ Middlewares ------------------

    const verifyToken = (req, res, next) => {
      const authHeader = req.headers.authorization;
      console.log('Auth Header:', authHeader);

      if (!authHeader) {
        return res.status(401).send({ message: 'Unauthorized access' });
      }
      const token = authHeader.split(' ')[1];
      console.log('Extracted Token:', token);

      jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) {
          console.log('JWT Verify Error:', err.message);
          return res.status(401).send({ message: 'Unauthorized access' });
        }
        console.log('Decoded:', decoded);
        req.decoded = decoded;
        next();
      });
    };
    const verifyCreator = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== 'creator') {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== 'admin') {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    const verifySupporter = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== 'supporter') {
        return res.status(403).send({ message: 'Forbidden access' });
      }
      next();
    };

    // ------------------ Root ------------------

    app.get('/', (req, res) => {
      res.send('Crowdfunding server is running');
    });

    // ------------------ JWT ------------------

    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.send({ token });
    });

    // ------------------ Users ------------------

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

    app.get('/users/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send(user);
    });

    // Get user role only (useful for client-side role checks)
    app.get('/users/role/:email', async (req, res) => {
      const email = req.params.email;
      const user = await usersCollection.findOne({ email });
      res.send({ role: user?.role || null });
    });

    // ------------------ Campaigns ------------------

    // Create a new campaign (Creator only)
    app.post('/campaigns', verifyToken, verifyCreator, async (req, res) => {
      const campaign = req.body;
      campaign.status = 'pending';
      campaign.raised_amount = 0;
      campaign.createdAt = new Date();
      const result = await campaignsCollection.insertOne(campaign);
      res.send(result);
    });

    // Get all approved campaigns (Explore Campaigns page) - only not expired
    app.get('/campaigns', async (req, res) => {
      const today = new Date();
      const campaigns = await campaignsCollection
        .find({ status: 'approved', deadline: { $gte: today.toISOString() } })
        .toArray();
      res.send(campaigns);
    });

    // Get top 6 funded campaigns (Home page)
    app.get('/campaigns/top-funded', async (req, res) => {
      const campaigns = await campaignsCollection
        .find({ status: 'approved' })
        .sort({ raised_amount: -1 })
        .limit(6)
        .toArray();
      res.send(campaigns);
    });

    // Get all pending campaigns (Admin)
    app.get('/campaigns/pending', verifyToken, verifyAdmin, async (req, res) => {
      const campaigns = await campaignsCollection.find({ status: 'pending' }).toArray();
      res.send(campaigns);
    });

    // Get campaigns created by a specific creator
    app.get('/campaigns/creator/:email', verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      const campaigns = await campaignsCollection
        .find({ creator_email: email })
        .sort({ deadline: -1 })
        .toArray();
      res.send(campaigns);
    });

    // Get all campaigns (Admin - Manage Campaigns)
    app.get('/campaigns/all', verifyToken, verifyAdmin, async (req, res) => {
      const campaigns = await campaignsCollection.find().toArray();
      res.send(campaigns);
    });

    // Get single campaign by id
    app.get('/campaigns/:id', async (req, res) => {
      const id = req.params.id;
      const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
      res.send(campaign);
    });

    // Update campaign (title, story, reward_info) - Creator only
    app.patch('/campaigns/:id', verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const { campaign_title, campaign_story, reward_info } = req.body;
      const result = await campaignsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { campaign_title, campaign_story, reward_info } }
      );
      res.send(result);
    });

    // Approve campaign (Admin)
    app.patch('/campaigns/approve/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await campaignsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'approved' } }
      );

      const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
      if (campaign) {
        await notificationsCollection.insertOne({
          message: `Your campaign "${campaign.campaign_title}" was approved by admin`,
          toEmail: campaign.creator_email,
          actionRoute: '/dashboard/creator-home',
          time: new Date(),
        });
      }

      res.send(result);
    });

    // Reject campaign (Admin)
    app.patch('/campaigns/reject/:id', verifyToken, verifyAdmin, async (req, res) => {
      const id = req.params.id;
      const result = await campaignsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'rejected' } }
      );

      const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
      if (campaign) {
        await notificationsCollection.insertOne({
          message: `Your campaign "${campaign.campaign_title}" was rejected by admin`,
          toEmail: campaign.creator_email,
          actionRoute: '/dashboard/creator-home',
          time: new Date(),
        });
      }

      res.send(result);
    });

    // Delete campaign - refund approved supporters' credits
    app.delete('/campaigns/:id', verifyToken, async (req, res) => {
      const id = req.params.id;

      // Refund all approved contributions for this campaign
      const approvedContributions = await contributionsCollection
        .find({ campaign_id: id, status: 'approved' })
        .toArray();

      for (const contribution of approvedContributions) {
        await usersCollection.updateOne(
          { email: contribution.Supporter_email },
          { $inc: { credits: contribution.Contribution_amount } }
        );
      }

      const result = await campaignsCollection.deleteOne({ _id: new ObjectId(id) });
      res.send(result);
    });

    // ------------------ Contributions ------------------

    // Create a new contribution (Supporter only) - deduct credits immediately
    app.post('/contributions', verifyToken, verifySupporter, async (req, res) => {
      const contribution = req.body;
      const supporter = await usersCollection.findOne({ email: contribution.Supporter_email });

      if (!supporter || supporter.credits < contribution.Contribution_amount) {
        return res.status(400).send({ message: 'Insufficient credits' });
      }

      // Deduct credits from supporter (held until approved/rejected)
      await usersCollection.updateOne(
        { email: contribution.Supporter_email },
        { $inc: { credits: -contribution.Contribution_amount } }
      );

      contribution.status = 'pending';
      contribution.current_date = new Date();
      const result = await contributionsCollection.insertOne(contribution);

      // Notify creator
      await notificationsCollection.insertOne({
        message: `${contribution.Supporter_name} contributed ${contribution.Contribution_amount} credits to your campaign "${contribution.campaign_title}"`,
        toEmail: contribution.creator_email,
        actionRoute: '/dashboard/creator-home',
        time: new Date(),
      });

      res.send(result);
    });

    // Get all contributions by a Supporter (My Contributions - with pagination)
    app.get('/contributions/supporter/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const page = parseInt(req.query.page) || 0;
      const size = parseInt(req.query.size) || 10;

      const total = await contributionsCollection.countDocuments({ Supporter_email: email });
      const result = await contributionsCollection
        .find({ Supporter_email: email })
        .sort({ current_date: -1 })
        .skip(page * size)
        .limit(size)
        .toArray();

      res.send({ contributions: result, total });
    });

    // Get approved contributions only (Supporter Home page)
    app.get('/contributions/approved/:email', verifyToken, async (req, res) => {
      const email = req.params.email;
      const result = await contributionsCollection
        .find({ Supporter_email: email, status: 'approved' })
        .toArray();
      res.send(result);
    });

    // Get pending contributions for a Creator's campaigns (Contributions To Review)
    app.get('/contributions/creator/:email', verifyToken, verifyCreator, async (req, res) => {
      const email = req.params.email;
      const result = await contributionsCollection
        .find({ creator_email: email, status: 'pending' })
        .toArray();
      res.send(result);
    });

    // Approve a contribution (Creator)
    app.patch('/contributions/approve/:id', verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const contribution = await contributionsCollection.findOne({ _id: new ObjectId(id) });

      if (!contribution) return res.status(404).send({ message: 'Contribution not found' });

      // Add amount to campaign's raised amount
      await campaignsCollection.updateOne(
        { _id: new ObjectId(contribution.campaign_id) },
        { $inc: { raised_amount: contribution.Contribution_amount } }
      );

      // Update contribution status
      const result = await contributionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'approved' } }
      );

      // Notify supporter
      await notificationsCollection.insertOne({
        message: `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was approved by ${contribution.creator_name}`,
        toEmail: contribution.Supporter_email,
        actionRoute: '/dashboard/supporter-home',
        time: new Date(),
      });

      res.send(result);
    });

    // Reject a contribution (Creator) - refund credits to supporter
    app.patch('/contributions/reject/:id', verifyToken, verifyCreator, async (req, res) => {
      const id = req.params.id;
      const contribution = await contributionsCollection.findOne({ _id: new ObjectId(id) });

      if (!contribution) return res.status(404).send({ message: 'Contribution not found' });

      // Refund credits back to supporter
      await usersCollection.updateOne(
        { email: contribution.Supporter_email },
        { $inc: { credits: contribution.Contribution_amount } }
      );

      const result = await contributionsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: 'rejected' } }
      );

      // Notify supporter
      await notificationsCollection.insertOne({
        message: `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was rejected by ${contribution.creator_name}`,
        toEmail: contribution.Supporter_email,
        actionRoute: '/dashboard/supporter-home',
        time: new Date(),
      });

      res.send(result);
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