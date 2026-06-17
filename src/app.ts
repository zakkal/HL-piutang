// ─── HL Sales & Receivables Management App ────────────────────
// Express Application Entry Point

import './env'; // MUST be first - loads .env before other modules
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { apiRateLimiter } from './middleware/rateLimiter';
import { globalErrorHandler } from './utils/errors';
import authRoutes from './routes/auth';
import customerRoutes from './routes/customers';
import productRoutes from './routes/products';
import transactionRoutes from './routes/transactions';
import reportRoutes from './routes/reports';
import aiRoutes from './routes/ai';

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(helmet());
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || false
    : true,
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api', apiRateLimiter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/products', productRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/ai', aiRoutes);

app.use((_req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    timestamp: new Date().toISOString(),
  });
});

app.use(globalErrorHandler);

app.listen(PORT, () => {
  console.log(`[HL Sales App] Server running on port ${PORT}`);
  console.log(`[HL Sales App] Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`[HL Sales App] Session timeout: ${process.env.SESSION_TIMEOUT_MINUTES || 15} minutes`);
});

export default app;