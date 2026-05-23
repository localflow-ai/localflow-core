class ProxyClient {

    constructor(baseUrl, token) {
        this.baseUrl = baseUrl;
        this.token = token;
    }

    async connect(type = 'odoo', config = {}) {
        const res = await fetch(`${this.baseUrl}/session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, config })
        });

        if (res.error) {
            throw new Error(`Login failed: ${res.error} - ${res.detail}`);
        }

        // this should be the right way to handle errors
        // if (!res.ok) {
        //     const err = await res.json();
        //     throw new Error(`Login failed: ${err.error} - ${err.detail || ''}`);
        // }

        const data = await res.json();
        this.token = data.token;
        return data;
    }

    isConnected() {
        return !!this.token;
    }

    async getSessionInfo() {
        console.info('[ProxyClient] getSessionInfo', this.token, this._headers());
        const res = await fetch(`${this.baseUrl}/session`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async signup(tenant, url, login, token, password) {
        const res = await fetch(`${this.baseUrl}/external-signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                tenant,
                url,
                login,
                token,
                password
            })
        });

        return this._handleResponse(res);
    }

    _headers(isProxyCall = false) {
        if (!this.token) throw new Error('Not authenticated');
        
        const headers = { 'Content-Type': 'application/json' };
        
        // Switch header name based on destination
        if (isProxyCall) {
            headers['X-Proxy-Token'] = `Bearer ${this.token}`;
        } else {
            headers['Authorization'] = `Bearer ${this.token}`;
        }
        
        return headers;
    }

    async _handleResponse(res) {
        if (!res.ok) {
            let message = res.statusText;
            try {
                const err = await res.json();
                message = err.error?.message || err.error || message;
            } catch {
                // fallback if response is not JSON
            }
            throw new Error(`[${res.status}] ${message}`);
        }
        return res.json();
    }

    setInputDataMapper(inputDataMapper) {
        this.inputDataMapper = inputDataMapper;
    }

    setOutputDataMapper(outputDataMapper) {
        this.outputDataMapper = outputDataMapper;
    }

    normalizeInputData(data, typePath) {
        if (this.inputDataMapper) {
            const normalizedData = this.inputDataMapper(data, typePath);
            Object.entries(normalizedData).forEach(([key, value]) => {
                if (value && typeof value === 'object') {
                    normalizedData[key] = this.normalizeInputData(value, `${typePath}.${key}`);
                }
            });
            return normalizedData;
        } else {
            return data;
        }
    }

    normalizeOutputData(data, typePath) {
        if (this.outputDataMapper) {
            const normalizedData = this.outputDataMapper(data, typePath);
            Object.entries(normalizedData).forEach(([key, value]) => {
                if (value && typeof value === 'object') {
                    normalizedData[key] = this.normalizeOutputData(value, `${typePath}.${key}`);
                }
            });
            return normalizedData;
        } else {
            return data;
        }
    }

    async apiConfig() {
        const res = await fetch(`${this.baseUrl}/common/api-config`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    // Can be used like fetch()
    async apiProxy(urlOrRequest, options = {}) {
        let targetUrl;
        let fetchOptions = { ...options };

        if (urlOrRequest instanceof Request) {
            targetUrl = urlOrRequest.url;
            fetchOptions.method = urlOrRequest.method || fetchOptions.method;
            // Merge headers: Request Headers < Options Headers < Proxy Headers
            const requestHeaders = Object.fromEntries(urlOrRequest.headers.entries());
            fetchOptions.headers = { ...requestHeaders, ...options.headers };
        } else {
            targetUrl = urlOrRequest;
        }

        const proxyUrl = new URL(`${this.baseUrl}/common/api-proxy`);
        proxyUrl.searchParams.set('url', targetUrl);

        // Inject proxy auth. This will NOT overwrite an 'Authorization' header in fetchOptions.headers
        fetchOptions.headers = {
            ...fetchOptions.headers,
            ...this._headers(true)
        };

        return fetch(proxyUrl.toString(), fetchOptions);
    }

    async accessStats(resource, read, scope, weight = 1) {
        const res = await fetch(`${this.baseUrl}/common/access-stats?resource=${encodeURIComponent(resource)}&read=${read}&scope=${encodeURIComponent(scope)}&weight=${weight}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    /** Checks if a string is in the format of an encrypted message (IV:Tag:Ciphertext) */
    isEncrypted(str) {
        const parts = str.split(':');
        if (parts.length !== 3) return false;
        const [iv, tag, ciphertext] = parts;
        const isHex = (h) => /^[0-9a-fA-F]+$/.test(h);
        return iv.length === 24 && tag.length === 32 && isHex(iv) && isHex(tag) && isHex(ciphertext);
    }

    /**
     * Encrypts a sensitive string via the server-side proxy.
     * @param {string} message - The clear-text string to encrypt.
     * @returns {Promise<Object>} - The JSON response containing the encrypted string.
     */
    async encryptMessage(message) {
        const res = await fetch(`${this.baseUrl}/common/encrypt`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ message })
        });
        return this._handleResponse(res);
    }

    async decryptMessage(message) {
        return fetch(`${this.baseUrl}/common/decrypt`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ message })
        }).then(res => this._handleResponse(res));
    }
    
    /**
     * Extracts text from a PDF, optionally filtering by a keyword.
     * @param {string} url - The URL of the PDF.
     * @param {string} [searchString] - Optional keyword to filter relevant pages.
     */
    async extractPdfText(url, searchString = null) {
        return fetch(`${this.baseUrl}/common/extract-pdf`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({ url, searchString })
        }).then(res => this._handleResponse(res));
    }

    /**
     * Sends a formula generation request to the Gemini API via the secure proxy.
     * @param {string} encryptedApiKey - The encrypted version of the user's API key.
     * @param {Object} payload - The Gemini request (contents, system_instruction, etc.).
     * @returns {Promise<Object>} - The raw JSON response from Gemini 3.
     */
    async genai(encryptedApiKey, payload) {
        const body = {
            encryptedApiKey,
            ...payload // Includes model, contents, system_instruction, and generation_config
        };

        const res = await fetch(`${this.baseUrl}/common/genai`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(body)
        });

        //return this._handleResponse(res);
        return res;
    }

    async createFieldMapping(objectTypeOrFieldMapping, fieldMapping) {
        let objectType;
        if (typeof objectTypeOrFieldMapping === 'object') {
            fieldMapping = objectTypeOrFieldMapping;
        }
        if (typeof objectTypeOrFieldMapping === 'string') {
            objectType = objectTypeOrFieldMapping;
        }
        const res = await fetch(`${this.baseUrl}/session/field-mapping` + (objectType ? `/${objectType}` : ''), {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(fieldMapping)
        });
        return this._handleResponse(res);
    }

    async createObjectTypeMapping(objectTypeMapping) {
        const res = await fetch(`${this.baseUrl}/session/object-type-mapping`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(objectTypeMapping)
        });
        return this._handleResponse(res);
    }

    async listObjectTypes() {
        const res = await fetch(`${this.baseUrl}/metadata`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async getMetadata(objectType) {
        const res = await fetch(`${this.baseUrl}/metadata/${objectType}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async getObjectTypeFromId(recordId) {
        const res = await fetch(`${this.baseUrl}/metadata/object-type/${recordId}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    /**
     * 
     * @param {string} objectType 
     * @param {{ fields?: string[], limit?: number, order?: string, where?: object }} [options]
     * 
     * Example of where (MongoDB style):
     * {
     *   "$or": [
     *       { "is_company": true },
     *       { "name": { "$like": "%abc%" } }
     *   ],
     *   "active": true,
     *   "$not": { "email": { "$like": "%spam%" } }
     *   }
     */
    async getData(objectType, { fields, where, limit, order } = {}) {
        const params = new URLSearchParams();
        if (fields) params.set('fields', fields.join(','));
        if (limit) params.set('limit', limit);
        if (order) params.set('order', JSON.stringify(order));
        if (where) params.set('where', JSON.stringify(where));

        const res = await fetch(`${this.baseUrl}/data/${objectType}?${params.toString()}`, {
            headers: this._headers()
        });

        const data = await this._handleResponse(res);
        console.debug(`[ProxyClient] getData(${objectType})`, data);
        return {
            records: data.records.map(record => this.normalizeOutputData(record, objectType)),
            totalSize: data.totalSize,
            totalFetched: data.totalFetched
        };
    }

    async getDataById(objectType, id) {
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            headers: this._headers()
        });
        const data = await this._handleResponse(res);
        return this.normalizeOutputData(data, objectType);
    }

    async createData(objectType, data) {
        data = this.normalizeInputData(data, objectType);
        const res = await fetch(`${this.baseUrl}/data/${objectType}`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify(data)
        });
        return this._handleResponse(res);
    }

    async updateData(objectType, id, updates) {
        updates = this.normalizeInputData(updates, objectType);
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            method: 'PUT',
            headers: this._headers(),
            body: JSON.stringify(updates)
        });
        return this._handleResponse(res);
    }

    async deleteData(objectType, id) {
        const res = await fetch(`${this.baseUrl}/data/${objectType}/${id}`, {
            method: 'DELETE',
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async getAttachments(objectType, objectId, mimeTypePrefix = '') {
        const res = await fetch(`${this.baseUrl}/attachments/${encodeURIComponent(objectType)}/${encodeURIComponent(objectId)}${mimeTypePrefix ? `?mimeTypePrefix=${encodeURIComponent(mimeTypePrefix)}` : ''}`, {
            headers: this._headers()
        });
        return this._handleResponse(res);
    }

    async sendEmail(toAddresses, subject, body, from) {
        const res = await fetch(`${this.baseUrl}/api/send-email`, {
            method: 'POST',
            headers: this._headers(),
            body: JSON.stringify({
                toAddresses,
                subject,
                body,
                from
            })
        });
    }
}

//import initSqlJs from "sql.js"; // npm install sql.js

class OfflineProxyClient extends ProxyClient {
    constructor(baseUrl, token, { autoSync = true, dbName = "daquota_proxy-offline-db" } = {}) {
        super(baseUrl, token);
        this.online = navigator.onLine;
        this.manualOverride = null;
        this.db = null;
        this.SQL = null;
        this.autoSync = autoSync;
        this.dbName = dbName;

        window.addEventListener("online", () => this._setOnline(true));
        window.addEventListener("offline", () => this._setOnline(false));
    }

    async initDB() {
        if (this.db) return;

        if (!this.SQL) {
            this.SQL = await initSqlJs({
                locateFile: file => `https://sql.js.org/dist/${file}`
            });
        }

        const existing = await this._loadFromIndexedDB();
        if (existing) {
            this.db = new this.SQL.Database(new Uint8Array(existing));
            console.log("[OfflineProxyClient] Loaded DB from IndexedDB");
        } else {
            this.db = new this.SQL.Database();
            this.db.run(`
                CREATE TABLE IF NOT EXISTS records (
                    objectType TEXT,
                    id TEXT,
                    data TEXT,
                    PRIMARY KEY (objectType, id)
                );
            `);
            this.db.run(`
                CREATE TABLE IF NOT EXISTS mutations (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    objectType TEXT,
                    action TEXT,
                    recordId TEXT,
                    payload TEXT,
                    status TEXT DEFAULT 'pending'
                );
            `);
            console.log("[OfflineProxyClient] Created new DB");
            await this._saveToIndexedDB();
        }
    }

    async _saveToIndexedDB() {
        if (!this.db) return;
        const binaryArray = this.db.export();
        const blob = new Blob([binaryArray], { type: "application/octet-stream" });
        const request = indexedDB.open(this.dbName, 1);

        request.onupgradeneeded = () => {
            request.result.createObjectStore("db");
        };

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const tx = request.result.transaction("db", "readwrite");
                tx.objectStore("db").put(blob, "sqlite");
                tx.oncomplete = () => resolve(true);
                tx.onerror = e => reject(e);
            };
            request.onerror = e => reject(e);
        });
    }

    async _loadFromIndexedDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);
            request.onupgradeneeded = () => {
                request.result.createObjectStore("db");
            };
            request.onsuccess = () => {
                const tx = request.result.transaction("db", "readonly");
                const getReq = tx.objectStore("db").get("sqlite");
                getReq.onsuccess = () => {
                    const blob = getReq.result;
                    if (!blob) return resolve(null);
                    blob.arrayBuffer().then(buf => resolve(buf));
                };
                getReq.onerror = e => reject(e);
            };
            request.onerror = e => reject(e);
        });
    }

    async _persist() {
        await this._saveToIndexedDB();
    }

    _setOnline(state) {
        this.online = this.manualOverride !== null ? this.manualOverride : state;
        if (this.online && this.autoSync) {
            this.sync();
        }
    }

    setMode(online) {
        this.manualOverride = online;
        this._setOnline(online);
    }

    async _queueMutation(action, objectType, recordId, payload) {
        await this.initDB();
        this.db.run(
            `INSERT INTO mutations (objectType, action, recordId, payload) VALUES (?, ?, ?, ?);`,
            [objectType, action, recordId, JSON.stringify(payload)]
        );
        await this._persist();
    }

    async sync() {
        await this.initDB();
        const stmt = this.db.prepare(`SELECT * FROM mutations WHERE status = 'pending' ORDER BY id ASC`);
        while (stmt.step()) {
            const row = stmt.getAsObject();
            try {
                if (row.action === "create") {
                    await super.createData(row.objectType, JSON.parse(row.payload));
                } else if (row.action === "update") {
                    await super.updateData(row.objectType, row.recordId, JSON.parse(row.payload));
                } else if (row.action === "delete") {
                    await super.deleteData(row.objectType, row.recordId);
                }
                this.db.run(`UPDATE mutations SET status = 'done' WHERE id = ?`, [row.id]);
                await this._persist();
            } catch (err) {
                console.error("Sync failed for mutation", row, err);
                break;
            }
        }
        stmt.free();
    }

    _matchWhereClause(record, where) {
        if (!where || typeof where !== "object") return true;

        for (let key in where) {
            const value = where[key];

            if (key === "$or" && Array.isArray(value)) {
                // At least one subcondition must match
                if (!value.some(sub => matchWhereClause(record, sub))) {
                    return false;
                }
            } else if (key === "$not") {
                // Negate the condition
                if (matchWhereClause(record, value)) {
                    return false;
                }
            } else if (typeof value === "object" && value !== null) {
                const [operator, operand] = Object.entries(value)[0];
                const fieldValue = record[key];

                switch (operator) {
                    case "$like": {
                        // Convert SQL % wildcard to regex
                        const regex = new RegExp(
                            "^" + operand.replace(/%/g, ".*") + "$",
                            "i"
                        );
                        if (!regex.test(fieldValue ?? "")) return false;
                        break;
                    }
                    case "$neq": {
                        if (fieldValue === operand) return false;
                        break;
                    }
                    case "$gt": {
                        if (!(fieldValue > operand)) return false;
                        break;
                    }
                    case "$lt": {
                        if (!(fieldValue < operand)) return false;
                        break;
                    }
                    case "$in": {
                        if (Array.isArray(operand)) {
                            if (!operand.includes(fieldValue)) return false;
                        } else {
                            console.warn("Unsupported $in operand", operand);
                            return false;
                        }
                        break;
                    }
                    default:
                        console.warn("Unsupported operator:", operator);
                        return false;
                }
            } else if (value === null) {
                // Null is represented as strict null
                if (record[key] !== null) return false;
            } else {
                // Equality check
                if (record[key] !== value) return false;
            }
        }

        return true;
    }


    async getData(objectType, { fields, where, limit, order } = {}) {
        if (this.online) {
            const data = await super.getData(objectType, { fields, where, limit, order });
            await this.initDB();
            const insert = this.db.prepare(
                `INSERT OR REPLACE INTO records (objectType, id, data) VALUES (?, ?, ?)`
            );
            data.records.forEach(record => {
                insert.run([objectType, record.id, JSON.stringify(record)]);
            });
            insert.free();
            await this._persist();
            return data;
        } else {
            await this.initDB();
            const rows = [];
            const stmt = this.db.prepare(`SELECT * FROM records WHERE objectType = ?`);
            stmt.bind([objectType]);
            while (stmt.step()) {
                const row = stmt.getAsObject();
                const record = JSON.parse(row.data);
                if (this._matchWhereClause(record, where)) {
                    rows.push(record);
                }
            }
            stmt.free();

            // apply limit/order client-side
            let result = rows;
            if (order) {
                const [field, dir] = Object.entries(order)[0];
                result = result.sort((a, b) =>
                    dir.toLowerCase() === "desc" ? b[field] - a[field] : a[field] - b[field]
                );
            }
            if (limit) {
                result = result.slice(0, limit);
            }
            if (fields) {
                result = result.map(r => {
                    const filtered = {};
                    fields.forEach(f => filtered[f] = r[f]);
                    return filtered;
                });
            }

            return { records: result, totalSize: result.length, totalFetched: result.length };
        }
    }

    async createData(objectType, data) {
        if (this.online) {
            return super.createData(objectType, data);
        } else {
            await this._queueMutation("create", objectType, null, data);
            const tempId = `temp_${Date.now()}`;
            await this.initDB();
            this.db.run(
                `INSERT INTO records (objectType, id, data) VALUES (?, ?, ?)`,
                [objectType, tempId, JSON.stringify({ ...data, id: tempId })]
            );
            await this._persist();
            return { ...data, id: tempId };
        }
    }

    async updateData(objectType, id, updates) {
        if (this.online) {
            return super.updateData(objectType, id, updates);
        } else {
            await this._queueMutation("update", objectType, id, updates);
            await this.initDB();
            this.db.run(
                `UPDATE records SET data = ? WHERE objectType = ? AND id = ?`,
                [JSON.stringify(updates), objectType, id]
            );
            await this._persist();
            return updates;
        }
    }

    async deleteData(objectType, id) {
        if (this.online) {
            return super.deleteData(objectType, id);
        } else {
            await this._queueMutation("delete", objectType, id, {});
            await this.initDB();
            this.db.run(
                `DELETE FROM records WHERE objectType = ? AND id = ?`,
                [objectType, id]
            );
            await this._persist();
            return { success: true, offline: true };
        }
    }
}


