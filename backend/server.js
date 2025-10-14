const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

// Load environment variables from .env file in project root
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Import routes
const eventsRouter = require('./routes/events');
const magicRouter = require('./routes/magic');
const completeRouter = require('./routes/complete');
const viewRouter = require('./routes/view');
const manageRouter = require('./routes/manage');

const app = express();

// Security middleware
app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.FRONTEND_URL 
    : 'http://localhost:3000',
  credentials: true
}));

// Logging
app.use(morgan('combined'));

// Body parsing
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, '../data/uploads')));

// Routes
app.use('/api/events', eventsRouter);
app.use('/api/magic', magicRouter);
app.use('/api/complete', completeRouter);
app.use('/api/view', viewRouter);
app.use('/api/manage', manageRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`🚀 GitDone API running on port ${PORT}`);
  console.log(`📁 Data directory: ${path.join(__dirname, '../data')}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;