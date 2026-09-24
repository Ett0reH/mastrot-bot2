// Connessione a Firestore con firebase-admin (solo lato server, F1). Progetto e database da
// firebase-applet-config.json; credenziali da FIREBASE_SERVICE_ACCOUNT_JSON oppure dalle
// Application Default Credentials dell'ambiente (es. il service account di Cloud Run).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { EngineConfig } from '../config/config';
import type { FirestoreLike } from './firestoreStore';

export function createFirestore(config: EngineConfig, cwd = process.cwd()): FirestoreLike {
  const configPath = join(cwd, 'firebase-applet-config.json');
  if (!existsSync(configPath)) throw new Error('firebase-applet-config.json mancante: Firestore non configurato');
  const firebaseConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { projectId?: string; firestoreDatabaseId?: string };
  if (!firebaseConfig.projectId) throw new Error('firebase-applet-config.json senza projectId');
  const name = 'mastrot-runtime';
  const app =
    getApps().find((a) => a.name === name) ??
    initializeApp(
      {
        credential: config.firebase.serviceAccountJson ? cert(JSON.parse(config.firebase.serviceAccountJson)) : applicationDefault(),
        projectId: firebaseConfig.projectId,
      },
      name,
    );
  const db = firebaseConfig.firestoreDatabaseId ? getFirestore(app, firebaseConfig.firestoreDatabaseId) : getFirestore(app);
  return db as unknown as FirestoreLike;
}
