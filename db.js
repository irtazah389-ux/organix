// Database layer for Vercel deployment — uses Postgres (Neon) instead of SQLite,
// because Vercel's serverless functions have an ephemeral filesystem: a SQLite
// file written during one request is not guaranteed to exist on the next request.
const { Pool } = require('pg');
const crypto = require('crypto');

let pool;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error(
        'No database connected. In your Vercel project, go to Storage -> connect a Postgres (Neon) database, then redeploy.'
      );
    }
    pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

function hashPassword(pw, salt) {
  return crypto.scryptSync(pw, salt, 64).toString('hex');
}

let schemaReady = null;
async function ensureSchema() {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    const db = getPool();
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL CHECK (role IN ('vendor','buyer','admin')),
        name TEXT,
        business_name TEXT,
        business_type TEXT,
        city TEXT,
        address TEXT,
        phone TEXT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        bank_account TEXT,
        account_title TEXT,
        verification_status TEXT DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        commission_pct REAL NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        vendor_id INTEGER NOT NULL REFERENCES users(id),
        category_id INTEGER NOT NULL REFERENCES categories(id),
        title TEXT NOT NULL,
        description TEXT,
        price REAL NOT NULL,
        moq INTEGER DEFAULT 1,
        stock INTEGER DEFAULT 0,
        image_emoji TEXT DEFAULT '📦',
        status TEXT DEFAULT 'live' CHECK (status IN ('live','pending','rejected')),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        buyer_id INTEGER NOT NULL REFERENCES users(id),
        vendor_id INTEGER NOT NULL REFERENCES users(id),
        product_id INTEGER NOT NULL,
        product_title TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        total_amount REAL NOT NULL,
        commission_amount REAL NOT NULL,
        payout_amount REAL NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
        created_at TIMESTAMP DEFAULT NOW(),
        confirmed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    const { rows } = await db.query('SELECT COUNT(*)::int AS c FROM categories');
    if (rows[0].c === 0) {
      await seed(db);
    }
  })();
  return schemaReady;
}

async function seed(db) {
  const cats = [
    ['Textiles & Fabric', 13],
    ['Handicrafts & Artisan', 16],
    ['Leather Goods', 15],
    ['Home Decor', 16],
    ['Food & Spices', 11],
  ];
  for (const [name, pct] of cats) {
    await db.query('INSERT INTO categories (name, commission_pct) VALUES ($1,$2)', [name, pct]);
  }

  function mkPass(pw) {
    const salt = crypto.randomBytes(16).toString('hex');
    return { salt, hash: hashPassword(pw, salt) };
  }

  async function mkUser(u) {
    const p = mkPass(u.password);
    const { rows } = await db.query(
      `INSERT INTO users (role,name,business_name,business_type,city,address,phone,email,password_hash,salt,bank_account,account_title,verification_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [u.role, u.name||null, u.business_name||null, u.business_type||null, u.city||null, u.address||null,
       u.phone||null, u.email, p.hash, p.salt, u.bank_account||null, u.account_title||null, u.verification_status||'n/a']
    );
    return rows[0].id;
  }

  await mkUser({ role:'admin', name:'Platform Admin', city:'Karachi', phone:'0300-0000000', email:'admin@organix.pk', password:'Admin@12345', verification_status:'n/a' });
  const vendor1 = await mkUser({ role:'vendor', name:'Amjad Textiles', business_name:'Amjad Textile Mills', business_type:'manufacturer', city:'Faisalabad', address:'Industrial Area, Faisalabad', phone:'0301-1234567', email:'vendor1@organix.pk', password:'Vendor@123', bank_account:'PK00-BANK-0001', account_title:'Amjad Textile Mills', verification_status:'verified' });
  const vendor2 = await mkUser({ role:'vendor', name:'Sindhi Handicrafts Co.', business_name:'Sindhi Handicrafts Co.', business_type:'artisan', city:'Hyderabad', address:'Old City, Hyderabad', phone:'0302-2345678', email:'vendor2@organix.pk', password:'Vendor@123', bank_account:'PK00-BANK-0002', account_title:'Sindhi Handicrafts Co.', verification_status:'pending' });
  await mkUser({ role:'buyer', name:'John Miller', address:'221B Baker Street, London, UK', phone:'+44-7000-000000', email:'buyer1@organix.pk', password:'Buyer@123', verification_status:'n/a' });

  const catId = async (name) => (await db.query('SELECT id FROM categories WHERE name=$1',[name])).rows[0].id;
  const catTextile = await catId('Textiles & Fabric');
  const catHandi = await catId('Handicrafts & Artisan');
  const catHome = await catId('Home Decor');

  async function mkProduct(vendor_id, category_id, title, description, price, moq, stock, image_emoji) {
    await db.query(
      `INSERT INTO products (vendor_id,category_id,title,description,price,moq,stock,image_emoji,status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'live')`,
      [vendor_id, category_id, title, description, price, moq, stock, image_emoji]
    );
  }
  await mkProduct(vendor1, catTextile, 'Handwoven Cotton Fabric (per meter)', 'Premium 100% cotton fabric, handwoven by artisans in Faisalabad. Ideal for export-grade garments.', 4.5, 500, 12000, '🧵');
  await mkProduct(vendor1, catTextile, 'Embroidered Lawn Suit Set', 'Traditional embroidered 3-piece lawn suit, export quality stitching.', 18, 100, 3000, '👗');
  await mkProduct(vendor2, catHandi, 'Hand-carved Wooden Jewellery Box', 'Sindhi artisan hand-carved rosewood jewellery box with mirror inlay work.', 22, 50, 800, '🎁');
  await mkProduct(vendor2, catHome, 'Ajrak Print Cushion Covers (set of 4)', 'Traditional Sindhi Ajrak block-print cushion covers, 100% cotton.', 15, 30, 1500, '🛋️');
}

module.exports = { getPool, ensureSchema, hashPassword };
