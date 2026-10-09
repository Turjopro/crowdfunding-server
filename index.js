const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
require('dotenv').config();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

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
  },
});

// ------------------ Collections ------------------
// (The driver connects automatically on the first query, so routes can be
// registered right away. This also makes the server work on Vercel.)

const db = client.db('crowdfundingDB');
const usersCollection = db.collection('users');
const campaignsCollection = db.collection('campaigns');
const contributionsCollection = db.collection('contributions');
const withdrawalsCollection = db.collection('withdrawals');
const notificationsCollection = db.collection('notifications');
const paymentsCollection = db.collection('payments');
const reportsCollection = db.collection('reports');

client
  .connect()
  .then(() => client.db('admin').command({ ping: 1 }))
  .then(() => console.log('Pinged your deployment. You successfully connected to MongoDB!'))
  .catch((err) => console.error('MongoDB connection error:', err));

// ------------------ Helpers ------------------

// Catches errors from async route handlers so the server never crashes
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const isExpired = (deadline) => {
  if (!deadline) return false;
  const time = new Date(deadline).getTime();
  return !Number.isNaN(time) && time < Date.now();
};

// ------------------ Middlewares ------------------

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).send({ message: 'Unauthorized access' });
  }
  const token = authHeader.split(' ')[1];

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).send({ message: 'Unauthorized access' });
    }
    req.decoded = decoded;
    next();
  });
};

const verifyCreator = ah(async (req, res, next) => {
  const user = await usersCollection.findOne({ email: req.decoded.email });
  if (!user || user.role !== 'creator') {
    return res.status(403).send({ message: 'Forbidden access' });
  }
  req.user = user;
  next();
});

const verifyAdmin = ah(async (req, res, next) => {
  const user = await usersCollection.findOne({ email: req.decoded.email });
  if (!user || user.role !== 'admin') {
    return res.status(403).send({ message: 'Forbidden access' });
  }
  req.user = user;
  next();
});

const verifySupporter = ah(async (req, res, next) => {
  const user = await usersCollection.findOne({ email: req.decoded.email });
  if (!user || user.role !== 'supporter') {
    return res.status(403).send({ message: 'Forbidden access' });
  }
  req.user = user;
  next();
});

// ------------------ Root ------------------

app.get('/', (req, res) => {
  res.send('Crowdfunding server is running');
});

// ------------------ JWT ------------------

app.post('/jwt', ah(async (req, res) => {
  const { email } = req.body;
  if (!email || typeof email !== 'string') {
    return res.status(400).send({ message: 'Email is required' });
  }
  const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.send({ token });
}));

// ------------------ Users ------------------

app.post('/users', ah(async (req, res) => {
  const user = req.body;

  // Only supporter or creator can self-register. Admin is set manually in the database.
  if (!['supporter', 'creator'].includes(user.role)) {
    user.role = 'supporter';
  }

  const existingUser = await usersCollection.findOne({ email: user.email });
  if (existingUser) {
    return res.status(400).send({ message: 'User already exists', insertedId: null });
  }

  // Credits are given once, on registration
  user.credits = user.role === 'creator' ? 20 : 50;
  user.createdAt = new Date();

  const result = await usersCollection.insertOne(user);
  res.send(result);
}));

// Get all users (Admin - Manage Users)
app.get('/users', verifyToken, verifyAdmin, ah(async (req, res) => {
  const result = await usersCollection.find().toArray();
  res.send(result);
}));

app.get('/users/:email', ah(async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send(user);
}));

// Get user role only (useful for client-side role checks)
app.get('/users/role/:email', ah(async (req, res) => {
  const email = req.params.email;
  const user = await usersCollection.findOne({ email });
  res.send({ role: user?.role || null });
}));

// Update a user's role (Admin)
app.patch('/users/role/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const { role } = req.body;

  if (!['supporter', 'creator', 'admin'].includes(role)) {
    return res.status(400).send({ message: 'Invalid role' });
  }

  const result = await usersCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { role } }
  );
  res.send(result);
}));

// Delete a user (Admin)
app.delete('/users/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const result = await usersCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
}));

// ------------------ Admin Stats ------------------

app.get('/admin-stats', verifyToken, verifyAdmin, ah(async (req, res) => {
  const totalSupporters = await usersCollection.countDocuments({ role: 'supporter' });
  const totalCreators = await usersCollection.countDocuments({ role: 'creator' });

  const creditsAgg = await usersCollection
    .aggregate([{ $group: { _id: null, total: { $sum: '$credits' } } }])
    .toArray();
  const totalCredits = creditsAgg[0]?.total || 0;

  const totalPayments = await paymentsCollection.countDocuments();
  const paymentsAgg = await paymentsCollection
    .aggregate([{ $group: { _id: null, total: { $sum: '$price' } } }])
    .toArray();
  const totalPaymentAmount = paymentsAgg[0]?.total || 0;

  res.send({
    totalSupporters,
    totalCreators,
    totalCredits,
    totalPayments,
    totalPaymentAmount,
  });
}));

// ------------------ Campaigns ------------------

// Create a new campaign (Creator only)
app.post('/campaigns', verifyToken, verifyCreator, ah(async (req, res) => {
  const campaign = req.body;
  campaign.creator_email = req.decoded.email;
  campaign.status = 'pending';
  campaign.raised_amount = 0;
  campaign.createdAt = new Date();
  const result = await campaignsCollection.insertOne(campaign);
  res.send(result);
}));

// Get all approved campaigns (Explore Campaigns page) - only not expired
app.get('/campaigns', ah(async (req, res) => {
  const today = new Date();
  const campaigns = await campaignsCollection
    .find({ status: 'approved', deadline: { $gte: today.toISOString() } })
    .toArray();
  res.send(campaigns);
}));

// Get top 6 funded campaigns (Home page)
app.get('/campaigns/top-funded', ah(async (req, res) => {
  const campaigns = await campaignsCollection
    .find({ status: 'approved' })
    .sort({ raised_amount: -1 })
    .limit(6)
    .toArray();
  res.send(campaigns);
}));

// Get all pending campaigns (Admin)
app.get('/campaigns/pending', verifyToken, verifyAdmin, ah(async (req, res) => {
  const campaigns = await campaignsCollection.find({ status: 'pending' }).toArray();
  res.send(campaigns);
}));

// Get campaigns created by a specific creator
app.get('/campaigns/creator/:email', verifyToken, verifyCreator, ah(async (req, res) => {
  const email = req.params.email;
  const campaigns = await campaignsCollection
    .find({ creator_email: email })
    .sort({ deadline: -1 })
    .toArray();
  res.send(campaigns);
}));

// Get all campaigns (Admin - Manage Campaigns)
app.get('/campaigns/all', verifyToken, verifyAdmin, ah(async (req, res) => {
  const campaigns = await campaignsCollection.find().toArray();
  res.send(campaigns);
}));

// Get single campaign by id
app.get('/campaigns/:id', ah(async (req, res) => {
  const id = req.params.id;
  const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
  res.send(campaign);
}));

// Update campaign (title, story, reward_info) - only the creator who owns it
app.patch('/campaigns/:id', verifyToken, verifyCreator, ah(async (req, res) => {
  const id = req.params.id;
  const { campaign_title, campaign_story, reward_info } = req.body;

  const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
  if (!campaign) return res.status(404).send({ message: 'Campaign not found' });
  if (campaign.creator_email !== req.decoded.email) {
    return res.status(403).send({ message: 'Forbidden access' });
  }

  const result = await campaignsCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { campaign_title, campaign_story, reward_info } }
  );
  res.send(result);
}));

// Approve campaign (Admin)
app.patch('/campaigns/approve/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
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
}));

// Reject campaign (Admin)
app.patch('/campaigns/reject/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
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
}));

// Delete campaign (owner creator or admin) - refund supporters' credits
app.delete('/campaigns/:id', verifyToken, ah(async (req, res) => {
  const id = req.params.id;

  const campaign = await campaignsCollection.findOne({ _id: new ObjectId(id) });
  if (!campaign) return res.status(404).send({ message: 'Campaign not found' });

  const requester = await usersCollection.findOne({ email: req.decoded.email });
  const isAdmin = requester?.role === 'admin';
  const isOwner = campaign.creator_email === req.decoded.email;
  if (!isAdmin && !isOwner) {
    return res.status(403).send({ message: 'Forbidden access' });
  }

  // Refund approved contributions AND pending ones (credits were deducted when they were made)
  const toRefund = await contributionsCollection
    .find({ campaign_id: id, status: { $in: ['approved', 'pending'] } })
    .toArray();

  for (const contribution of toRefund) {
    await usersCollection.updateOne(
      { email: contribution.Supporter_email },
      { $inc: { credits: contribution.Contribution_amount } }
    );
  }

  // Pending contributions of a deleted campaign can no longer be reviewed
  await contributionsCollection.updateMany(
    { campaign_id: id, status: 'pending' },
    { $set: { status: 'rejected' } }
  );

  const result = await campaignsCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
}));

// ------------------ Contributions ------------------

// Create a new contribution (Supporter only) - deduct credits immediately
app.post('/contributions', verifyToken, verifySupporter, ah(async (req, res) => {
  const body = req.body;
  const supporterEmail = req.decoded.email;

  const amount = Number(body.Contribution_amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).send({ message: 'Contribution amount must be a positive whole number' });
  }

  if (!ObjectId.isValid(body.campaign_id)) {
    return res.status(400).send({ message: 'Invalid campaign' });
  }
  const campaign = await campaignsCollection.findOne({ _id: new ObjectId(body.campaign_id) });
  if (!campaign) {
    return res.status(404).send({ message: 'Campaign not found' });
  }
  if (campaign.status !== 'approved') {
    return res.status(400).send({ message: 'This campaign is not open for contributions' });
  }
  if (isExpired(campaign.deadline)) {
    return res.status(400).send({ message: 'The deadline for this campaign has passed' });
  }

  const minimum = Number(campaign.minimum_Contribution ?? campaign.minimum_contribution ?? 0);
  if (amount < minimum) {
    return res.status(400).send({ message: `Minimum contribution is ${minimum} credits` });
  }

  // Deduct credits only if the supporter has enough (atomic - no race condition)
  const deduction = await usersCollection.updateOne(
    { email: supporterEmail, credits: { $gte: amount } },
    { $inc: { credits: -amount } }
  );
  if (deduction.modifiedCount === 0) {
    return res.status(400).send({ message: 'Insufficient credits' });
  }

  const contribution = {
    ...body,
    campaign_id: String(campaign._id),
    campaign_title: campaign.campaign_title,
    Contribution_amount: amount,
    Supporter_email: supporterEmail,
    Supporter_name: body.Supporter_name || req.user.name || req.user.displayName || '',
    creator_name: campaign.creator_name || body.creator_name || '',
    creator_email: campaign.creator_email,
    status: 'pending',
    current_date: new Date(),
  };
  const result = await contributionsCollection.insertOne(contribution);

  // Notify creator
  await notificationsCollection.insertOne({
    message: `${contribution.Supporter_name} contributed ${amount} credits to your campaign "${campaign.campaign_title}"`,
    toEmail: campaign.creator_email,
    actionRoute: '/dashboard/creator-home',
    time: new Date(),
  });

  res.send(result);
}));

// Get all contributions by a Supporter (My Contributions - with pagination)
app.get('/contributions/supporter/:email', verifyToken, ah(async (req, res) => {
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
}));

// Get approved contributions only (Supporter Home page)
app.get('/contributions/approved/:email', verifyToken, ah(async (req, res) => {
  const email = req.params.email;
  const result = await contributionsCollection
    .find({ Supporter_email: email, status: 'approved' })
    .toArray();
  res.send(result);
}));

// Get pending contributions for a Creator's campaigns (Contributions To Review)
app.get('/contributions/creator/:email', verifyToken, verifyCreator, ah(async (req, res) => {
  const email = req.params.email;
  const result = await contributionsCollection
    .find({ creator_email: email, status: 'pending' })
    .toArray();
  res.send(result);
}));

// Approve a contribution (only the creator of that campaign)
app.patch('/contributions/approve/:id', verifyToken, verifyCreator, ah(async (req, res) => {
  const id = req.params.id;
  const contribution = await contributionsCollection.findOne({ _id: new ObjectId(id) });

  if (!contribution) return res.status(404).send({ message: 'Contribution not found' });
  if (contribution.creator_email !== req.decoded.email) {
    return res.status(403).send({ message: 'Forbidden access' });
  }

  // Only a pending contribution can be approved (blocks double approval)
  const result = await contributionsCollection.updateOne(
    { _id: new ObjectId(id), status: 'pending' },
    { $set: { status: 'approved' } }
  );
  if (result.modifiedCount === 0) {
    return res.status(400).send({ message: 'This contribution was already processed' });
  }

  // Add amount to campaign's raised amount
  await campaignsCollection.updateOne(
    { _id: new ObjectId(contribution.campaign_id) },
    { $inc: { raised_amount: contribution.Contribution_amount } }
  );

  // Notify supporter
  await notificationsCollection.insertOne({
    message: `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was approved by ${contribution.creator_name}`,
    toEmail: contribution.Supporter_email,
    actionRoute: '/dashboard/supporter-home',
    time: new Date(),
  });

  res.send(result);
}));

// Reject a contribution (only the creator of that campaign) - refund credits to supporter
app.patch('/contributions/reject/:id', verifyToken, verifyCreator, ah(async (req, res) => {
  const id = req.params.id;
  const contribution = await contributionsCollection.findOne({ _id: new ObjectId(id) });

  if (!contribution) return res.status(404).send({ message: 'Contribution not found' });
  if (contribution.creator_email !== req.decoded.email) {
    return res.status(403).send({ message: 'Forbidden access' });
  }

  // Only a pending contribution can be rejected (blocks double refund)
  const result = await contributionsCollection.updateOne(
    { _id: new ObjectId(id), status: 'pending' },
    { $set: { status: 'rejected' } }
  );
  if (result.modifiedCount === 0) {
    return res.status(400).send({ message: 'This contribution was already processed' });
  }

  // Refund credits back to supporter
  await usersCollection.updateOne(
    { email: contribution.Supporter_email },
    { $inc: { credits: contribution.Contribution_amount } }
  );

  // Notify supporter
  await notificationsCollection.insertOne({
    message: `Your contribution of ${contribution.Contribution_amount} credits to ${contribution.campaign_title} was rejected by ${contribution.creator_name}`,
    toEmail: contribution.Supporter_email,
    actionRoute: '/dashboard/supporter-home',
    time: new Date(),
  });

  res.send(result);
}));

// ------------------ Withdrawals ------------------

// Get creator's total raised credits & available-to-withdraw amount
app.get('/withdrawals/summary/:email', verifyToken, verifyCreator, ah(async (req, res) => {
  const email = req.params.email;

  // Total raised across all this creator's campaigns
  const campaigns = await campaignsCollection.find({ creator_email: email }).toArray();
  const totalRaised = campaigns.reduce((sum, c) => sum + (c.raised_amount || 0), 0);

  // Total already requested/approved withdrawals (pending + approved count as "reserved")
  const withdrawals = await withdrawalsCollection
    .find({ creator_email: email, status: { $in: ['pending', 'approved'] } })
    .toArray();
  const totalWithdrawn = withdrawals.reduce((sum, w) => sum + (w.withdrawal_credit || 0), 0);

  const availableCredits = totalRaised - totalWithdrawn;

  res.send({
    totalRaised,
    totalWithdrawn,
    availableCredits,
    availableDollars: availableCredits / 20,
  });
}));

// Create a withdrawal request (Creator only)
app.post('/withdrawals', verifyToken, verifyCreator, ah(async (req, res) => {
  const { creator_name, payment_system, account_number } = req.body;
  const creator_email = req.decoded.email;
  const withdrawal_credit = Number(req.body.withdrawal_credit);

  if (!Number.isInteger(withdrawal_credit) || withdrawal_credit <= 0) {
    return res.status(400).send({ message: 'Withdrawal credit must be a positive whole number' });
  }
  if (withdrawal_credit < 200) {
    return res.status(400).send({ message: 'Minimum withdrawal is 200 credits ($10)' });
  }
  if (!payment_system || !account_number) {
    return res.status(400).send({ message: 'Payment system and account number are required' });
  }

  // Recalculate available credits server-side (never trust client)
  const campaigns = await campaignsCollection.find({ creator_email }).toArray();
  const totalRaised = campaigns.reduce((sum, c) => sum + (c.raised_amount || 0), 0);

  const existingWithdrawals = await withdrawalsCollection
    .find({ creator_email, status: { $in: ['pending', 'approved'] } })
    .toArray();
  const totalWithdrawn = existingWithdrawals.reduce((sum, w) => sum + (w.withdrawal_credit || 0), 0);

  const available = totalRaised - totalWithdrawn;

  if (withdrawal_credit > available) {
    return res.status(400).send({ message: 'Insufficient credit for this withdrawal' });
  }

  const withdrawal = {
    creator_email,
    creator_name: creator_name || req.user.name || req.user.displayName || '',
    withdrawal_credit,
    withdrawal_amount: withdrawal_credit / 20,
    payment_system,
    account_number,
    withdraw_date: new Date(),
    status: 'pending',
  };

  const result = await withdrawalsCollection.insertOne(withdrawal);
  res.send(result);
}));

// Get a creator's payment/withdrawal history
app.get('/withdrawals/creator/:email', verifyToken, verifyCreator, ah(async (req, res) => {
  const email = req.params.email;
  const result = await withdrawalsCollection
    .find({ creator_email: email })
    .sort({ withdraw_date: -1 })
    .toArray();
  res.send(result);
}));

// Get all pending withdrawal requests (Admin)
app.get('/withdrawals/pending', verifyToken, verifyAdmin, ah(async (req, res) => {
  const result = await withdrawalsCollection.find({ status: 'pending' }).toArray();
  res.send(result);
}));

// Approve a withdrawal (Admin - "Payment Success" button)
app.patch('/withdrawals/approve/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const withdrawal = await withdrawalsCollection.findOne({ _id: new ObjectId(id) });

  if (!withdrawal) return res.status(404).send({ message: 'Withdrawal request not found' });

  // Only a pending request can be approved (blocks double approval)
  const result = await withdrawalsCollection.updateOne(
    { _id: new ObjectId(id), status: 'pending' },
    { $set: { status: 'approved' } }
  );
  if (result.modifiedCount === 0) {
    return res.status(400).send({ message: 'This request was already processed' });
  }

  // Notify creator
  await notificationsCollection.insertOne({
    message: `Your withdrawal of ${withdrawal.withdrawal_credit} credits ($${withdrawal.withdrawal_amount}) has been processed`,
    toEmail: withdrawal.creator_email,
    actionRoute: '/dashboard/payment-history',
    time: new Date(),
  });

  res.send(result);
}));

// ------------------ Payments (Stripe) ------------------

// Credit packages (server-side source of truth, never trust client amount)
const creditPackages = {
  100: 10,
  300: 25,
  800: 60,
  1500: 110,
};

// Create a Stripe payment intent for a credit package
app.post('/create-payment-intent', verifyToken, ah(async (req, res) => {
  const { credits } = req.body;

  const priceInDollars = creditPackages[credits];
  if (!priceInDollars) {
    return res.status(400).send({ message: 'Invalid credit package' });
  }

  const amountInCents = priceInDollars * 100;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: amountInCents,
    currency: 'usd',
    payment_method_types: ['card'],
  });

  res.send({ clientSecret: paymentIntent.client_secret });
}));

// Confirm payment success - save record and increase supporter's credits
app.post('/payments', verifyToken, verifySupporter, ah(async (req, res) => {
  const email = req.decoded.email;
  const credits = Number(req.body.credits);
  const price = Number(req.body.price);
  const { transactionId } = req.body;

  const expectedPrice = creditPackages[credits];
  if (!expectedPrice || expectedPrice !== price) {
    return res.status(400).send({ message: 'Invalid payment details' });
  }
  if (!transactionId || typeof transactionId !== 'string') {
    return res.status(400).send({ message: 'Transaction id is required' });
  }

  // The same payment can never be credited twice
  const alreadySaved = await paymentsCollection.findOne({ transactionId });
  if (alreadySaved) {
    return res.status(400).send({ message: 'This payment was already recorded' });
  }

  // Confirm with Stripe that this payment really succeeded for the right amount
  let paymentIntent;
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(transactionId);
  } catch (err) {
    return res.status(400).send({ message: 'Could not verify this payment' });
  }
  if (paymentIntent.status !== 'succeeded' || paymentIntent.amount !== expectedPrice * 100) {
    return res.status(400).send({ message: 'Payment was not completed' });
  }

  const payment = {
    email,
    credits,
    price,
    transactionId,
    paymentDate: new Date(),
  };

  const result = await paymentsCollection.insertOne(payment);

  // Increase supporter's credits
  await usersCollection.updateOne({ email }, { $inc: { credits } });

  res.send(result);
}));

// Get a supporter's payment history
app.get('/payments/:email', verifyToken, ah(async (req, res) => {
  const email = req.params.email;
  const result = await paymentsCollection
    .find({ email })
    .sort({ paymentDate: -1 })
    .toArray();
  res.send(result);
}));

// ------------------ Notifications ------------------

// Get notifications for the logged-in user (sorted newest first)
app.get('/notifications/:email', verifyToken, ah(async (req, res) => {
  const email = req.params.email;
  const result = await notificationsCollection
    .find({ toEmail: email })
    .sort({ time: -1 })
    .toArray();
  res.send(result);
}));

// ------------------ Reports ------------------

// Create a report for a suspicious/fraudulent campaign (Supporter)
app.post('/reports', verifyToken, ah(async (req, res) => {
  const report = req.body;
  report.reportDate = new Date();
  report.status = 'pending';
  const result = await reportsCollection.insertOne(report);
  res.send(result);
}));

// Get all reports (Admin)
app.get('/reports', verifyToken, verifyAdmin, ah(async (req, res) => {
  const result = await reportsCollection.find().sort({ reportDate: -1 }).toArray();
  res.send(result);
}));

// Suspend the reported campaign (Admin)
app.patch('/campaigns/suspend/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const result = await campaignsCollection.updateOne(
    { _id: new ObjectId(id) },
    { $set: { status: 'suspended' } }
  );
  res.send(result);
}));

// Delete a report (Admin - after resolving)
app.delete('/reports/:id', verifyToken, verifyAdmin, ah(async (req, res) => {
  const id = req.params.id;
  const result = await reportsCollection.deleteOne({ _id: new ObjectId(id) });
  res.send(result);
}));

// ------------------ Error handler ------------------

app.use((err, req, res, next) => {
  console.error(err);
  const badId = err?.name === 'BSONError' || /24 character hex/.test(err?.message || '');
  res
    .status(badId ? 400 : 500)
    .send({ message: badId ? 'Invalid id' : 'Something went wrong on the server' });
});

// ------------------ Start ------------------

// Locally: node index.js starts the server. On Vercel the app is exported instead.
if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}

module.exports = app;