import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [, , mode, databasePath] = process.argv;
const sql = readFileSync(0, 'utf8');
const database = new DatabaseSync(databasePath);

try {
    if (mode === 'exec') {
        database.exec(sql);
    } else if (mode === 'query') {
        process.stdout.write(JSON.stringify(database.prepare(sql).all()));
    } else {
        throw new Error('Unsupported sqlite fixture mode.');
    }
} finally {
    database.close();
}
