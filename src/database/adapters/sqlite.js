import sqlite3 from 'sqlite3';
export class SQLiteAdapter {
    constructor(config) {
        this.db = null;
        this.connected = false;
        this.config = config;
        // For SQLite, use the database name as the file path
        this.dbPath = config.database;
    }
    async connect() {
        return new Promise((resolve, reject) => {
            this.db = new sqlite3.Database(this.dbPath, (err) => {
                if (err) {
                    this.connected = false;
                    reject(new Error(`Failed to connect to SQLite: ${err.message}`));
                }
                else {
                    this.connected = true;
                    resolve();
                }
            });
        });
    }
    async disconnect() {
        return new Promise((resolve, reject) => {
            if (this.db) {
                this.db.close((err) => {
                    if (err) {
                        reject(err);
                    }
                    else {
                        this.connected = false;
                        resolve();
                    }
                });
            }
            else {
                resolve();
            }
        });
    }
    async query(queryString, params) {
        if (!this.db) {
            throw new Error('Database not connected');
        }
        return new Promise((resolve, reject) => {
            if (queryString.trim().toUpperCase().startsWith('SELECT')) {
                this.db.all(queryString, params || [], (err, rows) => {
                    if (err) {
                        reject(new Error(`SQLite query error: ${err.message}`));
                    }
                    else {
                        resolve({
                            rows: rows || [],
                            rowCount: rows?.length || 0,
                        });
                    }
                });
            }
            else {
                this.db.run(queryString, params || [], function (err) {
                    if (err) {
                        reject(new Error(`SQLite query error: ${err.message}`));
                    }
                    else {
                        resolve({
                            rows: [],
                            rowCount: this.changes || 0,
                        });
                    }
                });
            }
        });
    }
    async getSchema(schema) {
        const tables = await this.getTables();
        const columns = await this.getColumns();
        return { tables, columns };
    }
    async getTables(schema) {
        const query = `
      SELECT 
        name as tableName,
        'main' as tableSchema,
        'BASE TABLE' as tableType
      FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `;
        const result = await this.query(query);
        return result.rows;
    }
    async getColumns(tableName, schema) {
        if (tableName && tableName !== '') {
            const query = `PRAGMA table_info(?)`;
            const result = await this.query(query, [tableName]);
            return result.rows.map((row) => ({
                columnName: row.name,
                dataType: row.type,
                isNullable: !row.notnull,
                columnDefault: row.dflt_value || undefined,
                tableName,
                tableSchema: 'main',
            }));
        }
        else {
            // Get columns for all tables
            const tablesResult = await this.getTables();
            const allColumns = [];
            for (const table of tablesResult) {
                const columnsResult = await this.getColumns(table.tableName);
                allColumns.push(...columnsResult);
            }
            return allColumns;
        }
    }
    getDatabaseType() {
        return 'sqlite';
    }
    isConnected() {
        return this.connected && this.db !== null;
    }
}
