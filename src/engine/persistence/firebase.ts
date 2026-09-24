// Connessione a Firestore con firebase-admin (solo lato server, F1). Progetto e database da
// firebase-applet-config.json; il database si sceglie per istanza con FIRESTORE_DATABASE_ID (uno per
// modalità: shadow, demo e live non condividono mai lo stato). Credenziali da
// FIREBASE_SERVICE_ACCOUNT_JSON oppure dalle Application Default Credentials (es. Cloud Run).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import type { EngineConfig } from '../config/config';
import type { FirestoreLike } from './firestoreStore';

/** Progetto e database Firestore dell'istanza: FIRESTORE_DATABASE_ID prevale sul file del repository. */
export function firestoreTarget(config: EngineConfig, cwd = process.cwd()): { projectId: string; databaseId: string | null } {
  const configPath = join(cwd, 'firebase-applet-config.json');
  if (!existsSync(configPath)) throw new Error('firebase-applet-config.json mancante: Firestore non configurato');
  const firebaseConfig = JSON.parse(readFileSync(configPath, 'utf8')) as { projectId?: string; firestoreDatabaseId?: string };
  if (!firebaseConfig.projectId) throw new Error('firebase-applet-config.json senza projectId');
  return { projectId: firebaseConfig.projectId, databaseId: config.firebase.databaseId ?? firebaseConfig.firestoreDatabaseId ?? null };
}

export function createFirestore(config: EngineConfig, cwd = process.cwd()): FirestoreLike {
  const { projectId, databaseId } = firestoreTarget(config, cwd);
  const name = 'mastrot-runtime';
  const app =
    getApps().find((a) => a.name === name) ??
    initializeApp(
      {
        credential: config.firebase.serviceAccountJson ? cert(JSON.parse(config.firebase.serviceAccountJson)) : applicationDefault(),
        projectId,
      },
      name,
    );
  const db = databaseId ? getFirestore(app, databaseId) : getFirestore(app);
  return db as unknown as FirestoreLike;
}
