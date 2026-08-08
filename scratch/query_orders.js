const path = require('path');
const dbPath = path.resolve(__dirname, '../checkorder.db');
const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database(dbPath);

db.all("SELECT * FROM orders LIMIT 20", [], (err, rows) => {
    if (err) {
        console.error(err);
        return;
    }
    console.log(`Found ${rows.length} orders:`);
    console.log(JSON.stringify(rows, null, 2));
    db.close();
});
