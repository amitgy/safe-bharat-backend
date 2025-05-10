// ~/Documents/safe-bharat/server.js
require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const Parser = require('rss-parser');
const rateLimit = require('express-rate-limit');
const apicache = require('apicache');

const app = express();
const parser = new Parser();
const cache = apicache.middleware;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100 }));
app.use(cache('5 minutes'));

// MongoDB Atlas Connection
mongoose
  .connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  })
  .then(() => console.log('Connected to MongoDB Atlas'))
  .catch((err) => console.error('MongoDB connection error:', err));

// Schemas
const alertSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  time: { type: Date, default: Date.now },
}, { timestamps: true });

const reportSchema = new mongoose.Schema({
  description: { type: String, required: true },
  location: String,
  media: String,
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

const resourceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: String,
  address: String,
  contact: String,
  city: String,
}, { timestamps: true });

const checkinSchema = new mongoose.Schema({
  message: { type: String, required: true },
  phone: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
}, { timestamps: true });

const fileSchema = new mongoose.Schema({
  originalName: { type: String, required: true },
  size: Number,
  mimetype: String,
  uploadDate: { type: Date, default: Date.now },
}, { timestamps: true });

const Alert = mongoose.model('Alert', alertSchema);
const Report = mongoose.model('Report', reportSchema);
const Resource = mongoose.model('Resource', resourceSchema);
const Checkin = mongoose.model('Checkin', checkinSchema);
const File = mongoose.model('File', fileSchema);

// Multer for File Uploads
const upload = multer({
  storage: multer.memoryStorage(), // Vercel-compatible
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'), false);
    }
  },
});

// Twilio Setup (Optional)
const twilioClient = process.env.TWILIO_SID
  ? twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// JWT Middleware
const authenticateToken = (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token required' });
  jwt.verify(token, process.env.JWT_SECRET || 'safebharatsecret', (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    req.user = user;
    next();
  });
};

// Mock Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'user' && password === 'pass') {
    const token = jwt.sign({ username }, process.env.JWT_SECRET || 'safebharatsecret', { expiresIn: '1h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

// API Endpoints
app.get('/api/alerts', async (req, res) => {
  try {
    const alerts = await Alert.find().sort({ time: -1 }).limit(50);
    res.json(alerts);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/alerts', authenticateToken, async (req, res) => {
  try {
    const { title, message } = req.body;
    const alert = new Alert({ title, message });
    await alert.save();
    res.status(201).json(alert);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/reports', authenticateToken, upload.single('media'), async (req, res) => {
  try {
    const { description, location } = req.body;
    const media = req.file ? `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}` : null;
    const report = new Report({ description, location, media });
    await report.save();
    res.status(201).json(report);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/resources', async (req, res) => {
  try {
    const { city } = req.query;
    if (!city) {
      const resources = await Resource.find().limit(100);
      return res.json(resources);
    }
    const response = await axios.get(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city + ', India')}&format=json&limit=1`);
    if (response.data.length === 0) {
      return res.status(404).json({ error: 'City not found' });
    }
    const resources = await Resource.find({ city: new RegExp(city, 'i') }).limit(50);
    res.json(resources);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/news', async (req, res) => {
  try {
    const feed = await parser.parseURL('https://pib.gov.in/rss.aspx');
    const news = feed.items.slice(0, 10).map(item => ({
      title: item.title,
      content: item.contentSnippet,
      source: 'PIB India',
      time: new Date(item.pubDate),
    }));
    res.json(news);
  } catch (err) {
    res.status(500).json({ error: 'Error fetching news' });
  }
});

app.post('/api/checkins', authenticateToken, async (req, res) => {
  try {
    const { message, phone } = req.body;
    const checkin = new Checkin({ message, phone });
    await checkin.save();
    if (twilioClient) {
      await twilioClient.messages.create({
        body: `Safe Bharat Check-In: ${message}`,
        from: process.env.TWILIO_PHONE,
        to: phone,
      });
    }
    res.status(201).json(checkin);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// New /upload Endpoint (No Authentication)
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = new File({
      originalName: req.file.originalname,
      size: req.file.size,
      mimetype: req.file.mimetype,
      uploadDate: new Date(),
    });
    await file.save();
    res.json({ message: 'File metadata saved!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Error Handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server locally, but not on Vercel
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
