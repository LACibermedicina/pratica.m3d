import pg from 'pg';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://revalida:revalida@localhost:5432/revalida',
  max: 10,
});

export const q = (texto, params) => pool.query(texto, params);
export default pool;
