"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signToken = signToken;
exports.verifyAuth = verifyAuth;
exports.verifyOwner = verifyOwner;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const turso_js_1 = require("../db/turso.js");
function jwtSecret() {
    const s = process.env.JWT_SECRET;
    if (!s)
        throw new Error('JWT_SECRET env var is not set');
    return s;
}
/** Sign a JWT valid for 30 days */
function signToken(user) {
    return jsonwebtoken_1.default.sign({ id: user.id, email: user.email }, jwtSecret(), { expiresIn: '30d' });
}
/** Verify token from `qm_token` cookie; attach user to req or reject 401 */
function verifyAuth(req, res, next) {
    const token = req.cookies?.qm_token;
    if (!token) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
    }
    try {
        const payload = jsonwebtoken_1.default.verify(token, jwtSecret());
        req.user = { id: payload.id, email: payload.email };
        next();
    }
    catch {
        res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
}
/**
 * Verify authenticated user owns the portfolio at req.params.id.
 * Must be used after verifyAuth.
 * Portfolios with owner_id IS NULL are accessible to any authenticated user (migration grace period).
 */
async function verifyOwner(req, res, next) {
    const portfolioId = parseInt(req.params.id, 10);
    if (Number.isNaN(portfolioId)) {
        res.status(400).json({ success: false, error: 'Invalid portfolio id' });
        return;
    }
    const portfolio = await (0, turso_js_1.queryOne)('SELECT id, owner_id FROM portfolios WHERE id = ? AND is_active = 1', [portfolioId]);
    if (!portfolio) {
        res.status(404).json({ success: false, error: 'Portfolio not found' });
        return;
    }
    // Unclaimed portfolio (owner_id IS NULL): claim it for the requesting user
    if (portfolio.owner_id == null) {
        await (0, turso_js_1.queryOne)('UPDATE portfolios SET owner_id = ? WHERE id = ?', [req.user.id, portfolioId]);
        next();
        return;
    }
    if (Number(portfolio.owner_id) !== req.user.id) {
        res.status(403).json({ success: false, error: 'Access denied' });
        return;
    }
    next();
}
