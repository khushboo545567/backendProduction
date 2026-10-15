/**
 * app.ts
 * server/thronet-server/src/app.ts
 * Express Application Configuration
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import mongoSanitize from 'express-mongo-sanitize';
import hpp from 'hpp';
import mongoose from 'mongoose';
import { MongoStore } from 'connect-mongo';
import passport from '@/config/oauth/passport.config';

// Routes (saari mounting routes/index.ts me hoti hai)
import apiRoutes from './routes/index';

import { User } from './auth/models';

// Config
import { LoggerUtil, requestLogger } from './shared/logger.util';
import NotificationService from './auth/services/notification.service';

interface CustomError extends Error {
    status?: number;
    statusCode?: number;
    code?: string;
}

const logger = LoggerUtil;
const app: Express = express();
const isProduction = process.env['NODE_ENV'] === 'production';

// ==================== TRUST PROXY ====================
// Railway sits behind exactly one reverse proxy layer.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// ==================== CORS ====================
// Production me sirf CORS_ORIGIN (comma separated) wali origins allowed hain.
// Vercel preview URLs sirf tab allowed jab ALLOW_VERCEL_PREVIEWS=true ho.
// Localhost sirf non-production me allowed hai.
const DEFAULT_ORIGINS = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:5173',
    'https://throne8-client-main.vercel.app',
];

const envOrigins = process.env['CORS_ORIGIN'] || process.env['ALLOWED_ORIGINS'] ||   process.env['CORS_ALLOWED_ORIGINS'] ||
'';
const allowedOrigins: string[] = envOrigins
    ? envOrigins.split(',').map((o) => o.trim()).filter(Boolean)
    : DEFAULT_ORIGINS;

const allowVercelPreviews = process.env['ALLOW_VERCEL_PREVIEWS']
    ? process.env['ALLOW_VERCEL_PREVIEWS'] === 'true'
    : !isProduction;

app.use(cors({
    origin: (origin, callback) => {
        // Server-to-server calls (no origin) allow karo
        if (!origin) return callback(null, true);

        const isVercel = allowVercelPreviews && /\.vercel\.app$/.test(origin);
        const isLocalhost = !isProduction && /^http:\/\/localhost:\d+$/.test(origin);

        if (allowedOrigins.includes('*') || allowedOrigins.includes(origin) || isVercel || isLocalhost) {
            return callback(null, origin);
        }

        const corsError: CustomError = new Error(`CORS: Origin ${origin} not allowed`);
        corsError.status = 403;
        corsError.code = 'CORS_NOT_ALLOWED';
        return callback(corsError);
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'x-client-version',
        'x-csrf-token'
    ],
    exposedHeaders: ['Authorization', 'Content-Length', 'X-CSRF-Token'],
    credentials: true
}));

// 1. Cookie parser and request logger
app.use(cookieParser());
app.use(requestLogger);

// 2. Body parsers
// Default 10mb. Agar kahin base64 payload bhejte ho toh JSON_BODY_LIMIT env se badhao.
const bodyLimit = process.env['JSON_BODY_LIMIT'] || '10mb';
app.use(express.json({ limit: bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: bodyLimit }));

// 3. Security middleware
app.use(helmet());
app.use(compression());

// 3a. NoSQL injection protection — `$` aur `.` keys strip karta hai
app.use((req: Request, _res: Response, next: NextFunction) => {
    if (req.body) req.body = mongoSanitize.sanitize(req.body);
    if (req.params) req.params = mongoSanitize.sanitize(req.params);
    next();
});

// 3b. HTTP Parameter Pollution protection
app.use(hpp());

// 4. Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
});
app.use('/api', limiter);

// 4a. Auth endpoints (login/signup/OTP) ke liye stricter limiter
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many auth attempts, please try again later.' },
});
app.use('/api/v1/auth', authLimiter);

// ==================== SESSION ====================
const sessionSecret = process.env['SESSION_SECRET'];
if (!sessionSecret) {
    throw new Error('SESSION_SECRET environment variable is required. Set it in .env.production');
}

app.use(session({
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: process.env['MONGODB_URI']
        ? MongoStore.create({
            mongoUrl: process.env['MONGODB_URI'],
            collectionName: 'sessions',
            ttl: 5 * 60,
            autoRemove: 'native',
        })
        : MongoStore.create({
            clientPromise: mongoose.connection.asPromise().then((m) => m.getClient()),
            collectionName: 'sessions',
            ttl: 5 * 60,
            autoRemove: 'native',
        }),
    cookie: {
        secure: isProduction,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 5 * 60 * 1000 // 5 min in ms
    }
}));

app.use(passport.initialize());

passport.serializeUser((user: any, done) => done(null, user.userId));
passport.deserializeUser(async (userId: string, done) => {
    try {
        const user = await User.findOne({ userId });
        done(null, user as any);
    } catch (err) {
        done(err as Error);
    }
});

// ==================== HEALTH CHECK ====================
// Liveness probe
app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        environment: process.env['NODE_ENV'],
        version: process.env['APP_VERSION'] || '1.0.0',
    });
});

// Readiness probe — MongoDB connected hai ya nahi
app.get('/api/v1/health/ready', (_req: Request, res: Response) => {
    const mongoState = mongoose.connection.readyState; // 1 = connected
    const isReady = mongoState === 1;

    res.status(isReady ? 200 : 503).json({
        status: isReady ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        dependencies: {
            mongodb: mongoState === 1 ? 'connected'
                : mongoState === 2 ? 'connecting'
                : mongoState === 3 ? 'disconnecting'
                : 'disconnected',
        },
    });
});

// ==================== ROUTES ====================
app.use('/api/v1', apiRoutes);

// ==================== 404 HANDLER ====================
app.use((req: Request, res: Response) => {
    res.status(404).json({
        status: 'error',
        message: `Route ${req.method} ${req.originalUrl} not found`,
        code: 'ROUTE_NOT_FOUND',
    });
});

// ==================== ERROR HANDLER ====================
app.use(((err: CustomError, req: Request, res: Response, _next: NextFunction) => {
    if (err.code === 'EBADCSRFTOKEN') {
        return res.status(403).json({
            status: 'error',
            message: 'Invalid CSRF token',
            code: 'CSRF_VALIDATION_FAILED',
        });
    }

    if (err.code === 'CORS_NOT_ALLOWED') {
        return res.status(403).json({
            status: 'error',
            message: 'Origin not allowed',
            code: 'CORS_NOT_ALLOWED',
        });
    }

    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method,
    });

    let statusCode = err.statusCode || err.status || 500;
    let message = err.message;

    // Mongoose validation/cast errors aur Zod errors ko 400 me map karo,
    // warna ye generic 500 ke peeche chhup jate hain.
    if (err.name === 'ValidationError' || err.name === 'CastError') {
        statusCode = 400;
        message = err.message;
    } else if (err.name === 'ZodError') {
        statusCode = 400;
        message = (err as any).errors?.map((e: any) => `${e.path?.join('.')}: ${e.message}`).join('; ') || 'Validation failed';
    }

    // Sirf genuine 500 errors ka message production me chhupao.
    // Operational errors (400/401/403/404/409) ka asli message hamesha bhejo.
    const isKnownOperationalError = statusCode < 500 && !!message;

    return res.status(statusCode).json({
        status: 'error',
        message: isKnownOperationalError
            ? message
            : (isProduction
                ? 'Internal server error'
                : message || 'Internal server error'),
    });
}) as express.ErrorRequestHandler);

export { app, NotificationService };