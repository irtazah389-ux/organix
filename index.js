// Vercel serverless function — handles every /api/* request.
// File name [...path].js makes this a catch-all route for any path depth.
const crypto = require('crypto');
const { getPool, ensureSchema, hashPassword } = require('../lib/db');

function verifyPassword(pw, salt, expectedHash) {
  const h = hashPassword(pw, salt);
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function publicUser(u) {
  if (!u) return null;
  const { password_hash, salt, ...rest } = u;
  return rest;
}
async function getUserFromReq(req, db) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const token = auth.slice(7);
  const s = await db.query('SELECT * FROM sessions WHERE token=$1', [token]);
  if (!s.rows[0]) return null;
  const u = await db.query('SELECT * FROM users WHERE id=$1', [s.rows[0].user_id]);
  return u.rows[0] || null;
}
function requireRole(user, role) {
  return user && user.role === role;
}

// ---- Route table: [method, patternParts, handler] ----
const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, parts: pattern.split('/').filter(Boolean), handler });
}
function matchRoute(method, segments) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.parts.length !== segments.length) continue;
    const params = {};
    let ok = true;
    for (let i = 0; i < r.parts.length; i++) {
      if (r.parts[i].startsWith(':')) params[r.parts[i].slice(1)] = segments[i];
      else if (r.parts[i] !== segments[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

// ---- Auth ----
route('POST', 'signup', async (req, res, db, params, body) => {
  const { role, name, business_name, business_type, city, address, phone, email, password, bank_account, account_title } = body;
  if (!role || !['vendor', 'buyer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (role === 'vendor' && !business_name) return res.status(400).json({ error: 'Business name is required for vendors' });
  if (role === 'buyer' && !name) return res.status(400).json({ error: 'Name is required for buyers' });

  const existing = await db.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rows[0]) return res.status(409).json({ error: 'An account with this email already exists' });

  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const verification_status = role === 'vendor' ? 'pending' : 'n/a';

  const ins = await db.query(
    `INSERT INTO users (role,name,business_name,business_type,city,address,phone,email,password_hash,salt,bank_account,account_title,verification_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [role, name || business_name, business_name || null, business_type || null, city || null, address || null,
     phone || null, email, hash, salt, bank_account || null, account_title || null, verification_status]
  );
  const user = (await db.query('SELECT * FROM users WHERE id=$1', [ins.rows[0].id])).rows[0];
  const token = makeToken();
  await db.query('INSERT INTO sessions (token,user_id) VALUES ($1,$2)', [token, user.id]);
  res.status(201).json({ token, user: publicUser(user) });
});

route('POST', 'login', async (req, res, db, params, body) => {
  const { email, password } = body;
  const r = await db.query('SELECT * FROM users WHERE email=$1', [email || '']);
  const user = r.rows[0];
  if (!user || !verifyPassword(password || '', user.salt, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = makeToken();
  await db.query('INSERT INTO sessions (token,user_id) VALUES ($1,$2)', [token, user.id]);
  res.status(200).json({ token, user: publicUser(user) });
});

route('POST', 'logout', async (req, res, db) => {
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) {
    await db.query('DELETE FROM sessions WHERE token=$1', [auth.slice(7)]);
  }
  res.status(200).json({ ok: true });
});

route('GET', 'me', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  res.status(200).json({ user: publicUser(user) });
});

// ---- Categories ----
route('GET', 'categories', async (req, res, db) => {
  const r = await db.query('SELECT * FROM categories ORDER BY name');
  res.status(200).json(r.rows);
});

// ---- Public products ----
route('GET', 'products', async (req, res, db, params, body, query) => {
  let sql = `SELECT p.*, c.name as category_name, c.commission_pct, u.business_name as vendor_name, u.city as vendor_city, u.verification_status as vendor_verification
             FROM products p JOIN categories c ON p.category_id=c.id JOIN users u ON p.vendor_id=u.id
             WHERE p.status='live'`;
  const args = [];
  if (query.category) { args.push(query.category); sql += ` AND c.id=$${args.length}`; }
  if (query.search) { args.push(`%${query.search}%`); sql += ` AND (p.title ILIKE $${args.length}`; args.push(`%${query.search}%`); sql += ` OR p.description ILIKE $${args.length})`; }
  if (query.sort === 'price_asc') sql += ' ORDER BY p.price ASC';
  else if (query.sort === 'price_desc') sql += ' ORDER BY p.price DESC';
  else sql += ' ORDER BY p.created_at DESC';
  const r = await db.query(sql, args);
  res.status(200).json(r.rows);
});

route('GET', 'products/:id', async (req, res, db, params) => {
  const r = await db.query(
    `SELECT p.*, c.name as category_name, c.commission_pct, u.business_name as vendor_name, u.city as vendor_city, u.verification_status as vendor_verification
     FROM products p JOIN categories c ON p.category_id=c.id JOIN users u ON p.vendor_id=u.id WHERE p.id=$1`,
    [params.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Product not found' });
  res.status(200).json(r.rows[0]);
});

// ---- Vendor routes ----
route('GET', 'vendor/products', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const r = await db.query(`SELECT p.*, c.name as category_name FROM products p JOIN categories c ON p.category_id=c.id WHERE vendor_id=$1 ORDER BY p.created_at DESC`, [user.id]);
  res.status(200).json(r.rows);
});

route('POST', 'vendor/products', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const { category_id, title, description, price, moq, stock, image_emoji } = body;
  if (!category_id || !title || !price) return res.status(400).json({ error: 'Category, title and price are required' });
  const ins = await db.query(
    `INSERT INTO products (vendor_id,category_id,title,description,price,moq,stock,image_emoji,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live') RETURNING id`,
    [user.id, category_id, title, description || '', price, moq || 1, stock || 0, image_emoji || '📦']
  );
  const r = await db.query('SELECT * FROM products WHERE id=$1', [ins.rows[0].id]);
  res.status(201).json(r.rows[0]);
});

route('PUT', 'vendor/products/:id', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const cur = await db.query('SELECT * FROM products WHERE id=$1', [params.id]);
  const prod = cur.rows[0];
  if (!prod || prod.vendor_id !== user.id) return res.status(404).json({ error: 'Product not found' });
  const fields = ['category_id', 'title', 'description', 'price', 'moq', 'stock', 'image_emoji'];
  const updates = fields.filter(f => body[f] !== undefined);
  if (updates.length) {
    const setSql = updates.map((f, i) => `${f}=$${i + 1}`).join(', ');
    await db.query(`UPDATE products SET ${setSql} WHERE id=$${updates.length + 1}`, [...updates.map(f => body[f]), params.id]);
  }
  const r = await db.query('SELECT * FROM products WHERE id=$1', [params.id]);
  res.status(200).json(r.rows[0]);
});

route('DELETE', 'vendor/products/:id', async (req, res, db, params) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const cur = await db.query('SELECT * FROM products WHERE id=$1', [params.id]);
  const prod = cur.rows[0];
  if (!prod || prod.vendor_id !== user.id) return res.status(404).json({ error: 'Product not found' });
  await db.query('DELETE FROM products WHERE id=$1', [params.id]);
  res.status(200).json({ ok: true });
});

route('GET', 'vendor/orders', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const r = await db.query(`SELECT o.*, u.name as buyer_name, u.address as buyer_address FROM orders o JOIN users u ON o.buyer_id=u.id WHERE o.vendor_id=$1 ORDER BY o.created_at DESC`, [user.id]);
  res.status(200).json(r.rows);
});

route('PUT', 'vendor/orders/:id', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const cur = await db.query('SELECT * FROM orders WHERE id=$1', [params.id]);
  const order = cur.rows[0];
  if (!order || order.vendor_id !== user.id) return res.status(404).json({ error: 'Order not found' });
  if (!['in_progress', 'cancelled'].includes(body.status)) return res.status(400).json({ error: 'Invalid status transition' });
  await db.query('UPDATE orders SET status=$1 WHERE id=$2', [body.status, params.id]);
  const r = await db.query('SELECT * FROM orders WHERE id=$1', [params.id]);
  res.status(200).json(r.rows[0]);
});

route('GET', 'vendor/earnings', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'vendor')) return res.status(403).json({ error: 'Vendor access only' });
  const completed = (await db.query(`SELECT COALESCE(SUM(payout_amount),0)::float as total, COUNT(*)::int as count FROM orders WHERE vendor_id=$1 AND status='completed'`, [user.id])).rows[0];
  const pending = (await db.query(`SELECT COALESCE(SUM(payout_amount),0)::float as total, COUNT(*)::int as count FROM orders WHERE vendor_id=$1 AND status IN ('pending','in_progress')`, [user.id])).rows[0];
  res.status(200).json({ paid_out: completed.total, paid_orders: completed.count, pending_payout: pending.total, pending_orders: pending.count });
});

// ---- Buyer routes ----
route('POST', 'orders', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'buyer')) return res.status(403).json({ error: 'Buyer access only' });
  const { product_id, quantity } = body;
  const prodRes = await db.query('SELECT * FROM products WHERE id=$1', [product_id]);
  const product = prodRes.rows[0];
  if (!product || product.status !== 'live') return res.status(404).json({ error: 'Product not available' });
  const qty = parseInt(quantity, 10) || 1;
  if (qty < product.moq) return res.status(400).json({ error: `Minimum order quantity is ${product.moq}` });
  const category = (await db.query('SELECT * FROM categories WHERE id=$1', [product.category_id])).rows[0];
  const total = product.price * qty;
  const commission = +(total * (category.commission_pct / 100)).toFixed(2);
  const payout = +(total - commission).toFixed(2);
  const ins = await db.query(
    `INSERT INTO orders (buyer_id,vendor_id,product_id,product_title,quantity,total_amount,commission_amount,payout_amount,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending') RETURNING id`,
    [user.id, product.vendor_id, product.id, product.title, qty, total, commission, payout]
  );
  const r = await db.query('SELECT * FROM orders WHERE id=$1', [ins.rows[0].id]);
  res.status(201).json(r.rows[0]);
});

route('GET', 'buyer/orders', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'buyer')) return res.status(403).json({ error: 'Buyer access only' });
  const r = await db.query(`SELECT o.*, u.business_name as vendor_name FROM orders o JOIN users u ON o.vendor_id=u.id WHERE o.buyer_id=$1 ORDER BY o.created_at DESC`, [user.id]);
  res.status(200).json(r.rows);
});

route('POST', 'buyer/orders/:id/confirm', async (req, res, db, params) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'buyer')) return res.status(403).json({ error: 'Buyer access only' });
  const cur = await db.query('SELECT * FROM orders WHERE id=$1', [params.id]);
  const order = cur.rows[0];
  if (!order || order.buyer_id !== user.id) return res.status(404).json({ error: 'Order not found' });
  if (order.status === 'completed') return res.status(400).json({ error: 'Order already completed' });
  await db.query(`UPDATE orders SET status='completed', confirmed_at=NOW() WHERE id=$1`, [params.id]);
  const r = await db.query('SELECT * FROM orders WHERE id=$1', [params.id]);
  res.status(200).json(r.rows[0]);
});

// ---- Admin routes ----
route('GET', 'admin/vendors', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  const r = await db.query(`SELECT id,name,business_name,business_type,city,phone,email,verification_status,created_at FROM users WHERE role='vendor' ORDER BY created_at DESC`);
  res.status(200).json(r.rows);
});

route('POST', 'admin/vendors/:id/verify', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  if (!['verified', 'rejected', 'pending'].includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
  await db.query(`UPDATE users SET verification_status=$1 WHERE id=$2 AND role='vendor'`, [body.status, params.id]);
  res.status(200).json({ ok: true });
});

route('GET', 'admin/products', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  const r = await db.query(`SELECT p.*, c.name as category_name, u.business_name as vendor_name FROM products p JOIN categories c ON p.category_id=c.id JOIN users u ON p.vendor_id=u.id ORDER BY p.created_at DESC`);
  res.status(200).json(r.rows);
});

route('POST', 'admin/products/:id/moderate', async (req, res, db, params, body) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  if (!['live', 'rejected', 'pending'].includes(body.status)) return res.status(400).json({ error: 'Invalid status' });
  await db.query('UPDATE products SET status=$1 WHERE id=$2', [body.status, params.id]);
  res.status(200).json({ ok: true });
});

route('GET', 'admin/orders', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  const r = await db.query(`SELECT o.*, b.name as buyer_name, v.business_name as vendor_name FROM orders o JOIN users b ON o.buyer_id=b.id JOIN users v ON o.vendor_id=v.id ORDER BY o.created_at DESC`);
  res.status(200).json(r.rows);
});

route('GET', 'admin/stats', async (req, res, db) => {
  const user = await getUserFromReq(req, db);
  if (!requireRole(user, 'admin')) return res.status(403).json({ error: 'Admin access only' });
  const vendors = (await db.query(`SELECT COUNT(*)::int c FROM users WHERE role='vendor'`)).rows[0].c;
  const verifiedVendors = (await db.query(`SELECT COUNT(*)::int c FROM users WHERE role='vendor' AND verification_status='verified'`)).rows[0].c;
  const buyers = (await db.query(`SELECT COUNT(*)::int c FROM users WHERE role='buyer'`)).rows[0].c;
  const liveProducts = (await db.query(`SELECT COUNT(*)::int c FROM products WHERE status='live'`)).rows[0].c;
  const gmv = (await db.query(`SELECT COALESCE(SUM(total_amount),0)::float s FROM orders WHERE status='completed'`)).rows[0].s;
  const commission = (await db.query(`SELECT COALESCE(SUM(commission_amount),0)::float s FROM orders WHERE status='completed'`)).rows[0].s;
  const ordersByStatus = (await db.query(`SELECT status, COUNT(*)::int c FROM orders GROUP BY status`)).rows;
  res.status(200).json({ vendors, verifiedVendors, buyers, liveProducts, gmv, commission, ordersByStatus });
});

// ---- Entry point ----
module.exports = async (req, res) => {
  try {
    await ensureSchema();
    const db = getPool();

    // vercel.json rewrites /api/:path* -> /api/index?path=:path*, so the
    // remaining path arrives as a single slash-joined string, not an array.
    const rawPath = Array.isArray(req.query.path) ? req.query.path.join('/') : (req.query.path || '');
    const segments = rawPath.split('/').filter(Boolean);
    const match = matchRoute(req.method, segments);
    if (!match) return res.status(404).json({ error: 'Not found' });

    let body = req.body;
    if (typeof body === 'string') {
      try { body = body ? JSON.parse(body) : {}; } catch (e) { body = {}; }
    }
    if (!body || typeof body !== 'object') body = {};

    const query = { ...req.query };
    delete query.path;

    await match.handler(req, res, db, match.params, body, query);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error', detail: e.message });
  }
};
