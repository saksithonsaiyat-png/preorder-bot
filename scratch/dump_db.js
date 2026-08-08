const path = require('path');
const dbPath = path.resolve(__dirname, '../checkorder.db');

try {
    const { DatabaseSync } = require('node:sqlite');
    const nativeDb = new DatabaseSync(dbPath);
    console.log('Tables in database:');
    const tables = nativeDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    console.log(tables);

    console.log('\nSystem settings:');
    const settings = nativeDb.prepare("SELECT * FROM system_settings").all();
    console.log(settings);

    console.log('\nNumber of accounts:');
    const accountsCount = nativeDb.prepare("SELECT COUNT(*) as count FROM accounts").get();
    console.log(accountsCount);

    console.log('\nNumber of orders:');
    const ordersCount = nativeDb.prepare("SELECT COUNT(*) as count FROM orders").get();
    console.log(ordersCount);
} catch (e) {
    console.error('Error:', e.message);
}
