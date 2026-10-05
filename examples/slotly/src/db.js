// Thin helpers over a D1 database (env.DB). Tests pass an in-memory stand-in with the same shape.
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
