import { initializeApp } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore/lite';
import * as fs from 'fs';
import * as path from 'path';

async function fetchState() {
  const configPath = path.join(process.cwd(), 'firebase-applet-config.json');
  if (fs.existsSync(configPath)) {
    const firebaseConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const app = initializeApp(firebaseConfig);
    const db = getFirestore(app, firebaseConfig.firestoreDatabaseId); 
    const liveDoc = await getDoc(doc(db, "bots", "live"));
    const data = liveDoc.data();
    console.log("Firebase state:", JSON.stringify({
      baseBalance: data?.baseBalance,
      balance: data?.balance,
      isActive: data?.isActive
    }, null, 2));
  } else {
    console.log("No config");
  }
}
fetchState();
