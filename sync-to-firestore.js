const admin = require('firebase-admin');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

// 1. Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');
if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const firestoreDb = admin.firestore();

// 2. Open SQLite Database
const dbPath = path.resolve(__dirname, 'checkorder.db');
const db = new DatabaseSync(dbPath);

async function syncSQLiteToFirestore() {
    console.log('🔄 เริ่มต้นซิงค์ข้อมูลจาก SQLite (checkorder.db) ไปยัง Firebase Firestore...\n');

    const accounts = db.prepare('SELECT * FROM accounts').all();
    const orders = db.prepare('SELECT * FROM orders').all();

    console.log(`📊 พบข้อมูลใน SQLite:`);
    console.log(`- บัญชีผู้ใช้ (accounts): ${accounts.length} บัญชี`);
    console.log(`- รายการออเดอร์ (orders): ${orders.length} รายการ\n`);

    const now = new Date().toISOString();
    const batch = firestoreDb.batch();

    // Map order count per account
    const orderCountByUser = {};
    orders.forEach(o => {
        const u = o.username || 'unknown';
        orderCountByUser[u] = (orderCountByUser[u] || 0) + 1;
    });

    // 1. Sync accounts to 'accounts' collection
    accounts.forEach(acc => {
        const uname = acc.username.trim();
        const docRef = firestoreDb.collection('accounts').doc(uname);
        const accData = {
            username: uname,
            status: acc.status || 'active',
            order_count: orderCountByUser[uname] || 0,
            queue_position: acc.queue_position || 0,
            queue_status: acc.queue_status || 'Processing',
            is_new: false,
            last_updated: acc.last_updated || now,
            source: 'SQLite Migration (One-time Sync)'
        };
        batch.set(docRef, accData, { merge: true });
        console.log(`  ➕ เตรียมข้อมูล Account: "${uname}"`);
    });

    // 2. Sync orders to 'orders' collection
    orders.forEach(ord => {
        const uname = ord.username.trim();
        const orderId = `ORD_${ord.id}_${uname.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
        const docRef = firestoreDb.collection('orders').doc(orderId);
        const ordData = {
            order_id: orderId,
            sqlite_id: ord.id,
            username: uname,
            product_name: ord.product_name,
            product_image: ord.product_image || null,
            queue_position: ord.queue_position || 0,
            queue_status: ord.queue_status || 'Pending',
            estimated_wait_time: ord.estimated_wait_time || '-',
            notes: ord.notes || 'ข้อมูลจากระบบทดสอบ SQLite',
            buyer_notes: ord.buyer_notes || '',
            purchase_time: ord.purchase_time || now,
            wait_time_target: ord.wait_time_target || null,
            last_updated: ord.last_updated || now
        };
        batch.set(docRef, ordData, { merge: true });
        console.log(`  ➕ เตรียมข้อมูล Order ID [${orderId}] สำหรับผู้ใช้ "${uname}" (${ord.product_name})`);
    });

    // Commit batch to Firestore
    console.log('\n⏳ กำลังส่งข้อมูลไปยัง Firebase Firestore Cloud...');
    await batch.commit();
    console.log('✅ บันทึกข้อมูลขึ้น Firestore สำเร็จเรียบร้อยแล้ว!\n');

    // Verification
    console.log('🔍 ตรวจสอบความถูกต้องจาก Firestore:');
    const accSnapshot = await firestoreDb.collection('accounts').get();
    console.log(`- Collection "accounts": มีทั้งหมด ${accSnapshot.size} เอกสาร`);
    accSnapshot.forEach(doc => console.log(`   • docId: ${doc.id}`));

    const ordSnapshot = await firestoreDb.collection('orders').get();
    console.log(`- Collection "orders": มีทั้งหมด ${ordSnapshot.size} เอกสาร`);
    ordSnapshot.forEach(doc => console.log(`   • docId: ${doc.id} | Product: ${doc.data().product_name}`));

    console.log('\n🎉 สำเร็จ! รีเฟรชหน้า Firebase Console ดูข้อมูลได้เลยครับ!');
}

syncSQLiteToFirestore().catch(err => {
    console.error('❌ เกิดข้อผิดพลาดในการซิงค์:', err);
    process.exit(1);
});
