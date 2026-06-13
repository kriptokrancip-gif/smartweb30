const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const { spawn, exec, execSync } = require('child_process');
require('dotenv').config();

const app = express();

// Use the robust 'cors' package
app.use(cors({
    origin: (origin, callback) => {
        // Allow all origins (for local development)
        callback(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization']
}));

app.use(express.json({ limit: '50mb' }));

// Ultra-detailed logger
app.use((req, res, next) => {
    console.log(`[HTTP] ${req.method} ${req.url} - Origin: ${req.headers.origin || 'N/A'}`);
    next();
});

const IS_WINDOWS = process.platform === 'win32';
const PORT = 18088;
const ROOT_DIR = IS_WINDOWS 
    ? 'C:\\Users\\Ewg3\\Documents\\SmartHome_Vault\\Agent_Data'
    : '/mnt/c/Users/Ewg3/Documents/SmartHome_Vault/Agent_Data';
const USERS_ROOT = path.join(ROOT_DIR, 'users');
const USER_TEMPLATE_DIR = path.join(USERS_ROOT, 'TEMPLATE');
const HUB_ROOT = path.join(ROOT_DIR, 'hub');
const HUB_SCRIPTS_DIR = path.join(HUB_ROOT, 'scripts');
const HUB_AGENT_TEMPLATES_DIR = path.join(HUB_ROOT, 'agent_templates');
const HUB_REGISTRY_DIR = path.join(HUB_ROOT, 'registry');

// Windows-specific path for USERPROFILE if running in WSL
const ROOT_DIR_WIN = 'C:\\Users\\Ewg3\\Documents\\SmartHome_Vault\\Agent_Data';

const GEMINI_BIN = '/home/ewg3/.npm-global/bin/gemini';
const CODEX_BIN = '/home/ewg3/.npm-global/bin/codex';

// Keys found in migration/scripts
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_DEFAULT_MODEL = 'openrouter/free'; // Best fallback
const XIAOMI_API_KEY = 'sk-sq7lzduufiljk1wkkqzox0gq28zapcsqwfw3gwq0audlswb0';
const XIAOMI_MODEL = 'xiaomi/mimo-v2.5-pro';
const OLLAMA_HOST = 'http://127.0.0.1:11434';
const OLLAMA_DEFAULT_MODEL = 'llama3.2:1b';
const GEMMA_DEFAULT_MODEL = 'gemma2:2b';

const geminiAuthProcesses = new Map();
const codexAuthProcesses = new Map();

const OWNER_USER_IDS = new Set((process.env.SMARTWEB_OWNER_IDS || '945996850').split(',').map(s => s.trim()).filter(Boolean));
const ADMIN_USER_IDS = new Set((process.env.SMARTWEB_ADMIN_USER_IDS || '326451285').split(',').map(s => s.trim()).filter(Boolean));
const FREE_USER_AGENTS = new Set((process.env.SMARTWEB_FREE_USER_AGENTS || 'openrouter,ollama,gemma').split(',').map(s => s.trim()).filter(Boolean));
const DEFAULT_FREE_AGENT = process.env.SMARTWEB_DEFAULT_FREE_AGENT || 'openrouter';
const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL || 'http://127.0.0.1:3100';
const HERMES_GATEWAY_URL = process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642';

function getUserRole(userId) {
    const safeId = sanitizeUserId(userId);
    if (OWNER_USER_IDS.has(safeId)) return 'owner';
    if (ADMIN_USER_IDS.has(safeId)) return 'admin';
    return 'user';
}

function canUseAgent(userId, agent) {
    const role = getUserRole(userId);
    if (role === 'owner' || role === 'admin') return true;
    return FREE_USER_AGENTS.has(agent);
}

function readJsonFile(filePath, fallback = {}) {
    try {
        if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.warn(`[JSON] Failed to read ${filePath}: ${e.message}`);
    }
    return fallback;
}

function writeJsonFile(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function getUserWorkspace(userId) {
    const safeId = sanitizeUserId(userId);
    const serverPath = ensureUserDirs(safeId);
    return {
        user_id: safeId,
        server_path: serverPath,
        windows_path: path.join(ROOT_DIR_WIN, 'users', safeId),
        vault_path: IS_WINDOWS
            ? 'C:\\Users\\Ewg3\\Documents\\SmartHome_Vault'
            : '/mnt/c/Users/Ewg3/Documents/SmartHome_Vault',
        goals_file: path.join(serverPath, 'goals.md'),
        tasks_dir: path.join(serverPath, 'tasks'),
        logs_dir: path.join(serverPath, 'logs'),
        paperclip_dir: path.join(serverPath, 'paperclip'),
        scripts_dir: path.join(serverPath, 'scripts'),
        bots_dir: path.join(serverPath, 'bots'),
        agents_dir: path.join(serverPath, 'agents'),
        registry_dir: path.join(serverPath, 'registry'),
        hub_root: HUB_ROOT,
        hub_scripts_dir: HUB_SCRIPTS_DIR,
        hub_agent_templates_dir: HUB_AGENT_TEMPLATES_DIR,
        hub_registry_dir: HUB_REGISTRY_DIR
    };
}

function getPaperclipActiveAgent(userId) {
    const safeId = sanitizeUserId(userId);
    const activePath = path.join(ensureUserDirs(safeId), 'paperclip', 'active_agent.json');
    const active = readJsonFile(activePath, null);
    if (!active || !active.agent) return null;
    return {
        agent: String(active.agent).trim(),
        source: 'paperclip.active_agent',
        activated_at: active.activated_at || active.updated_at || null,
        meta: active
    };
}

function setPaperclipActiveAgent(userId, agent, source = 'smartweb30') {
    const safeId = sanitizeUserId(userId);
    const activePath = path.join(ensureUserDirs(safeId), 'paperclip', 'active_agent.json');
    const role = getUserRole(safeId);
    const allowedAgent = canUseAgent(safeId, agent) ? agent : DEFAULT_FREE_AGENT;
    const record = {
        user_id: safeId,
        role,
        agent: allowedAgent,
        requested_agent: agent,
        limited: allowedAgent !== agent,
        source,
        activated_at: new Date().toISOString()
    };
    writeJsonFile(activePath, record);
    return record;
}

function resolveAgentForUser(userId, requestedAgent) {
    const paperclipActive = getPaperclipActiveAgent(userId);
    const agent = requestedAgent || paperclipActive?.agent || getUserAgent(userId) || DEFAULT_FREE_AGENT;
    return canUseAgent(userId, agent) ? agent : DEFAULT_FREE_AGENT;
}

function resolveAgentState(userId, requestedAgent) {
    const paperclipActive = getPaperclipActiveAgent(userId);
    const legacyAgent = getUserAgent(userId);
    const candidate = requestedAgent || paperclipActive?.agent || legacyAgent || DEFAULT_FREE_AGENT;
    const agent = canUseAgent(userId, candidate) ? candidate : DEFAULT_FREE_AGENT;
    return {
        agent,
        requested_agent: requestedAgent || null,
        source: requestedAgent ? 'request' : (paperclipActive ? paperclipActive.source : 'current_agent.txt'),
        legacy_agent: legacyAgent,
        paperclip_active_agent: paperclipActive,
        limited: agent !== candidate,
        role: getUserRole(userId)
    };
}

function appendUserLog(userId, filename, record) {
    const userDir = ensureUserDirs(userId);
    const logDir = path.join(userDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, filename), JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n', 'utf8');
}

function ensurePaperclipMirror(userId) {
    const safeId = sanitizeUserId(userId);
    const workspace = getUserWorkspace(safeId);
    const paperclipDir = workspace.paperclip_dir;
    fs.mkdirSync(paperclipDir, { recursive: true });
    const officePath = path.join(paperclipDir, 'office.json');
    const role = getUserRole(safeId);
    const agentState = resolveAgentState(safeId);
    const existingOffice = readJsonFile(officePath, {});
    const activatedAgents = Array.isArray(existingOffice.activated_agents)
        ? Array.from(new Set([...existingOffice.activated_agents, agentState.agent]))
        : [agentState.agent];
    const office = {
        ...existingOffice,
        user_id: safeId,
        role,
        company_slug: role === 'owner' ? 'owner-945' : `user-${safeId}`,
        paperclip_url: process.env.PAPERCLIP_PUBLIC_URL || 'https://paper.smrmarkets.ru',
        api_url: PAPERCLIP_API_URL,
        default_agent: DEFAULT_FREE_AGENT,
        active_agent: agentState.agent,
        active_agent_source: agentState.source,
        activated_agents: activatedAgents,
        workspace_path: workspace.server_path,
        workspace,
        policy: role === 'user' ? 'free-model-only' : 'admin-routing-allowed',
        updated_at: new Date().toISOString()
    };
    writeJsonFile(officePath, office);
    return office;
}

function sanitizeSlug(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'item';
}

function listFilesWithExt(dirPath, ext) {
    if (!fs.existsSync(dirPath)) return [];
    return fs.readdirSync(dirPath)
        .filter(name => name.toLowerCase().endsWith(ext))
        .map(name => path.join(dirPath, name));
}

function ensureScriptHub() {
    fs.mkdirSync(HUB_SCRIPTS_DIR, { recursive: true });
    fs.mkdirSync(HUB_AGENT_TEMPLATES_DIR, { recursive: true });
    fs.mkdirSync(HUB_REGISTRY_DIR, { recursive: true });
    const registryPath = path.join(HUB_REGISTRY_DIR, 'scripts_registry.json');
    const files = listFilesWithExt(HUB_SCRIPTS_DIR, '.py');
    const scripts = files.map(filePath => {
        const stat = fs.statSync(filePath);
        return {
            id: sanitizeSlug(path.basename(filePath, '.py')),
            name: path.basename(filePath),
            path: filePath,
            scope: 'hub',
            origin: 'hub',
            updated_at: stat.mtime.toISOString(),
            size: stat.size
        };
    });
    const registry = {
        updated_at: new Date().toISOString(),
        hub_root: HUB_ROOT,
        scripts_dir: HUB_SCRIPTS_DIR,
        count: scripts.length,
        scripts
    };
    writeJsonFile(registryPath, registry);
    return registry;
}

function syncUserScriptWorkspace(userId) {
    const safeId = sanitizeUserId(userId);
    const workspace = getUserWorkspace(safeId);
    ensureScriptHub();
    fs.mkdirSync(workspace.scripts_dir, { recursive: true });
    fs.mkdirSync(workspace.registry_dir, { recursive: true });

    const copied = [];
    for (const legacyFile of listFilesWithExt(workspace.bots_dir, '.py')) {
        const target = path.join(workspace.scripts_dir, path.basename(legacyFile));
        if (!fs.existsSync(target)) {
            fs.copyFileSync(legacyFile, target);
            copied.push(path.basename(legacyFile));
        }
    }

    const scriptPaths = new Map();
    for (const filePath of listFilesWithExt(workspace.scripts_dir, '.py')) {
        scriptPaths.set(path.basename(filePath).toLowerCase(), { filePath, origin: 'scripts' });
    }
    for (const filePath of listFilesWithExt(workspace.bots_dir, '.py')) {
        const key = path.basename(filePath).toLowerCase();
        if (!scriptPaths.has(key)) scriptPaths.set(key, { filePath, origin: 'bots_legacy' });
    }
    for (const filePath of listFilesWithExt(HUB_SCRIPTS_DIR, '.py')) {
        const key = path.basename(filePath).toLowerCase();
        if (!scriptPaths.has(key)) scriptPaths.set(key, { filePath, origin: 'hub_shared' });
    }

    const scripts = Array.from(scriptPaths.values())
        .map(({ filePath, origin }) => {
            const stat = fs.statSync(filePath);
            return {
                id: sanitizeSlug(path.basename(filePath, '.py')),
                name: path.basename(filePath),
                path: filePath,
                origin,
                scope: 'user',
                updated_at: stat.mtime.toISOString(),
                size: stat.size
            };
        })
        .sort((a, b) => a.name.localeCompare(b.name));

    const registry = {
        user_id: safeId,
        updated_at: new Date().toISOString(),
        copied_from_legacy_bots: copied,
        scripts_dir: workspace.scripts_dir,
        bots_dir: workspace.bots_dir,
        hub_scripts_dir: HUB_SCRIPTS_DIR,
        count: scripts.length,
        scripts
    };
    writeJsonFile(path.join(workspace.registry_dir, 'scripts_registry.json'), registry);
    return registry;
}

function getUserAgentsRegistry(userId) {
    const safeId = sanitizeUserId(userId);
    const workspace = getUserWorkspace(safeId);
    fs.mkdirSync(workspace.agents_dir, { recursive: true });
    fs.mkdirSync(HUB_AGENT_TEMPLATES_DIR, { recursive: true });
    const agentPaths = new Map();
    for (const dirPath of [workspace.agents_dir, HUB_AGENT_TEMPLATES_DIR]) {
        const origin = dirPath === workspace.agents_dir ? 'user' : 'hub_template';
        for (const name of fs.readdirSync(dirPath).filter(name => /\.(json|ya?ml)$/i.test(name))) {
            const filePath = path.join(dirPath, name);
            const key = name.toLowerCase();
            if (!agentPaths.has(key)) agentPaths.set(key, { filePath, origin });
        }
    }
    const agents = Array.from(agentPaths.values()).map(({ filePath, origin }) => {
        const stat = fs.statSync(filePath);
        return {
            id: sanitizeSlug(path.basename(filePath).replace(/\.(json|ya?ml)$/i, '')),
            name: path.basename(filePath),
            path: filePath,
            origin,
            updated_at: stat.mtime.toISOString(),
            size: stat.size
        };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const active = resolveAgentState(safeId);
    const registry = {
        user_id: safeId,
        updated_at: new Date().toISOString(),
        active_agent: active.agent,
        role: active.role,
        agents
    };
    writeJsonFile(path.join(workspace.registry_dir, 'agents_registry.json'), registry);
    return registry;
}

function ensureWorkspaceRegistry(userId) {
    const safeId = sanitizeUserId(userId);
    const workspace = getUserWorkspace(safeId);
    const scriptRegistry = syncUserScriptWorkspace(safeId);
    const agentRegistry = getUserAgentsRegistry(safeId);
    ensurePaperclipMirror(safeId);
    const registry = {
        user_id: safeId,
        updated_at: new Date().toISOString(),
        role: getUserRole(safeId),
        workspace,
        scripts: {
            count: scriptRegistry.count,
            registry_file: path.join(workspace.registry_dir, 'scripts_registry.json')
        },
        agents: {
            count: agentRegistry.agents.length,
            registry_file: path.join(workspace.registry_dir, 'agents_registry.json'),
            active_agent: agentRegistry.active_agent
        },
        paperclip: {
            office_file: path.join(workspace.paperclip_dir, 'office.json')
        },
        hub: {
            root: HUB_ROOT,
            scripts_dir: HUB_SCRIPTS_DIR,
            registry_dir: HUB_REGISTRY_DIR
        }
    };
    writeJsonFile(path.join(workspace.registry_dir, 'workspace_registry.json'), registry);
    return registry;
}

// Transcription lock to prevent multiple concurrent Whisper runs
let isTranscribing = false;

// Shared state for UI synchronization
let globalChatHistory = [];
let systemState = {
    isListening: true,
    isSpeaking: false,
    isProcessing: false,
    lastUpdate: Date.now()
};

// === HELPERS ===
function isLocalRequest(req) {
    const ip = req.ip || req.socket?.remoteAddress || '';
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

function isAdminRequest(req) {
    const token = process.env.SMARTWEB_ADMIN_TOKEN;
    if (token && req.headers['x-smartweb-admin-token'] === token) return true;
    return isLocalRequest(req);
}

function sanitizeUserId(userId) {
    return String(userId || '').replace(/[^0-9]/g, '') || '945996850';
}

function ensureUserDirs(userId) {
    const safeId = sanitizeUserId(userId);
    const userDir = path.join(USERS_ROOT, safeId);
    if (!fs.existsSync(userDir)) {
        console.log(`[PROVISION] Creating directory for user ${safeId}`);
        fs.mkdirSync(userDir, { recursive: true });
        if (fs.existsSync(USER_TEMPLATE_DIR)) {
            try {
                // Use native Node.js recursive copy for better performance
                fs.cpSync(USER_TEMPLATE_DIR, userDir, { recursive: true });
                console.log(`[PROVISION] Template copied for ${safeId}`);
            } catch (err) {
                console.error(`[PROVISION] Template copy error: ${err}`);
            }
        }
    }
    for (const subdir of ['agents', 'bots', 'knowledge', 'logs', 'media', 'paperclip', 'tasks', 'scripts', 'registry']) {
        fs.mkdirSync(path.join(userDir, subdir), { recursive: true });
    }
    const goalsPath = path.join(userDir, 'goals.md');
    if (!fs.existsSync(goalsPath)) {
        fs.writeFileSync(goalsPath, `# Goals for ${safeId}\n\n- [ ] Define first goal\n`, 'utf8');
    }
    return userDir;
}

function getAgentFile(userId) {
    return path.join(ensureUserDirs(userId), 'current_agent.txt');
}

function getUserAgent(userId) {
    const file = getAgentFile(userId);
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    return 'openrouter'; // Default for new users
}

function setUserAgent(userId, agent) {
    const userDir = ensureUserDirs(userId);
    fs.writeFileSync(path.join(userDir, 'current_agent.txt'), agent);
    
    // Also sync with profile.json for bot compatibility
    const profilePath = path.join(userDir, 'profile.json');
    let profile = {};
    if (fs.existsSync(profilePath)) {
        try { profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')); } catch(e) {}
    }
    profile.agent = agent;
    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    console.log(`[AGENT] User ${userId} set to ${agent}`);
}

function getIsolatedEnv(userId, agent) {
    const safeId = sanitizeUserId(userId);
    const userDir = ensureUserDirs(userId);
    const userDirWin = path.join(ROOT_DIR_WIN, 'users', safeId);
    
    const env = {
        ...process.env,
        HOME: userDir,
        USERPROFILE: userDirWin,
        HOMEDRIVE: userDirWin.slice(0, 2),
        HOMEPATH: userDirWin.slice(2),
        NO_BROWSER: 'true',
        LANG: 'en_US.UTF-8'
    };

    // Clear sensitive global keys to ensure user-level auth triggers
    // We set them to empty strings rather than deleting them to override any parent .env files
    env.GEMINI_API_KEY = '';
    env.OPENAI_API_KEY = '';
    env.ANTHROPIC_API_KEY = '';
    env.GOOGLE_API_KEY = '';
    env.OPENROUTER_API_KEY = '';

    if (agent === 'codex') {
        env.OPENAI_REDIRECT_URI = 'http://localhost:18088/v1/auth/codex/callback';
    }

    return env;
}

function cleanCliOutput(output, agent) {
    let text = String(output || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
    if (agent === 'gemini') {
        text = text.replace(/Warning: True color.*?\n/g, '')
                   .replace(/Using a terminal.*?\n/g, '')
                   .replace(/YOLO mode is enabled.*?\n/g, '')
                   .replace(/Loaded cached credentials.*?\n/g, '')
                   .replace(/Ripgrep is not available.*?\n/g, '')
                   .replace(/▝▜▄.*? Gemini CLI v\d+\.\d+\.\d+/gs, ''); // Remove big logo
    }
    return text.trim();
}

// === ENDPOINTS ===

app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT }));

// History management
app.get('/api/history', (req, res) => {
    res.json(globalChatHistory);
});

// System State management
app.get('/api/system/state', (req, res) => {
    res.json(systemState);
});

app.post('/api/system/state', (req, res) => {
    systemState = { ...systemState, ...req.body, lastUpdate: Date.now() };
    res.json(systemState);
});

app.post('/api/system/toggle-listening', (req, res) => {
    systemState.isListening = !systemState.isListening;
    systemState.lastUpdate = Date.now();
    console.log(`[SYSTEM] Voice listening toggled: ${systemState.isListening}`);
    res.json({ ok: true, isListening: systemState.isListening });
});

// Voice Transcription via WSL Whisper
app.post('/api/voice/transcribe', async (req, res) => {
    const { audio, user_id } = req.body;
    const sanitizedId = sanitizeUserId(user_id);
    console.log(`[VOICE] Received transcription request for user ${sanitizedId}`);

    if (!audio) {
        console.error('[VOICE] Error: No audio data received.');
        return res.status(400).json({ error: 'No audio data' });
    }

    const userDir = ensureUserDirs(sanitizedId);
    const audioPath = path.join(userDir, 'voice_input.webm');
    
    try {
        const buffer = Buffer.from(audio, 'base64');
        fs.writeFileSync(audioPath, buffer);
        console.log(`[VOICE] Audio data saved to ${audioPath}`);

        const wslAudioPath = audioPath.replace(/C:\\/i, '/mnt/c/').replace(/\\/g, '/');
        const whisperUrl = "http://127.0.0.1:18084/transcribe";
        const curlCmd = `wsl curl -s -X POST -F "file=@${wslAudioPath}" ${whisperUrl}`;
        
        console.log(`[VOICE] Executing Whisper command: ${curlCmd}`);

        exec(curlCmd, (err, stdout, stderr) => {
            if (err) {
                console.error(`[VOICE] Whisper Server Exec Error: ${err.message}`);
                console.error(`[VOICE] Stderr: ${stderr}`);
                return res.status(500).json({ error: 'Transcription command failed', details: err.message });
            }
            
            console.log(`[VOICE] Whisper Server Raw Response: ${stdout}`);

            try {
                const result = JSON.parse(stdout);
                const text = result.text || "";
                console.log(`[VOICE] Successfully Transcribed: "${text}"`);
                res.json({ text });
            } catch (e) {
                console.error(`[VOICE] Failed to parse JSON from Whisper server. Output: ${stdout}`);
                res.status(500).json({ error: 'Invalid response from Whisper server' });
            }
        });
    } catch (e) {
        console.error(`[VOICE] Catastrophic processing error: ${e.message}`);
        res.status(500).json({ error: 'Internal server error during audio processing' });
    }
});

app.post('/api/history', (req, res) => {
    const { message, sender } = req.body;
    if (message && sender) {
        globalChatHistory.push({
            id: Date.now() + Math.random(),
            sender,
            text: message,
            timestamp: new Date().toLocaleTimeString()
        });
        // Keep only last 50 messages
        if (globalChatHistory.length > 50) globalChatHistory.shift();
    }
    res.json({ ok: true });
});

// Switch Agent
app.post('/v1/users/:userId/agent', (req, res) => {
    const userId = sanitizeUserId(req.params.userId);
    const requestedAgent = req.body.agent;
    if (!['gemini', 'codex', 'openrouter', 'ollama', 'gemma', 'xiaomi'].includes(requestedAgent)) {
        return res.status(400).json({ error: 'Invalid agent' });
    }
    const agent = resolveAgentForUser(userId, requestedAgent);
    setUserAgent(userId, agent);
    const active = setPaperclipActiveAgent(userId, agent, 'agent.switch');
    ensurePaperclipMirror(userId);
    const limited = agent !== requestedAgent;
    res.json({ ok: true, agent, requested_agent: requestedAgent, limited, role: getUserRole(userId), active });
});

// Auth Request
app.post('/v1/auth/request', async (req, res) => {
    const userId = sanitizeUserId(req.body.user_id);
    const agent = req.body.agent || 'gemini';
    console.log(`[AUTH] Request for ${userId} (${agent})`);

    const userDir = ensureUserDirs(userId);
    const bin = agent === 'codex' ? CODEX_BIN : GEMINI_BIN;
    
    const cmdPrefix = agent === 'codex' ? 'login --device-auth' : '';
    const args = agent === 'gemini' ? '--skip-trust' : '';
    const cmd = `script -qfc \"${bin} ${cmdPrefix} ${args}\" /dev/null`;
    const shell = '/bin/bash';
    const shellArgs = ['-c', cmd];
    
    const proc = spawn(shell, shellArgs, {
        cwd: userDir,
        env: getIsolatedEnv(userId, agent)
    });

    const state = { proc, output: '', createdAt: Date.now() };
    if (agent === 'gemini') geminiAuthProcesses.set(userId, state); else if (agent === 'codex') codexAuthProcesses.set(userId, state);

    const authLog = path.join(userDir, 'auth_debug.log');
    fs.writeFileSync(authLog, `--- Auth Start ${new Date().toISOString()} ---\n`);

    let found = false;

    // For Gemini, we need to send '1\n' after delay ONLY IF menu is shown
    if (agent === 'gemini') {
    const sendOne = (attempt) => {
        try { 
            const cleaned = state.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
            if (!found && (cleaned.includes('1. Sign in with Google') || cleaned.includes('Get started') || cleaned.includes('How would you like to authenticate'))) {
                console.log(`[AUTH] Sending '1\\n' to Gemini for ${userId} (attempt ${attempt})`);
                state.proc.stdin.write('1\n'); 
                return true;
            }
            return false;
        } catch(e) {
            console.error(`[AUTH] Stdin write error for ${userId}: ${e.message}`);
            return true; // Stop trying on error
        }
    };

    setTimeout(() => { if (!sendOne(1)) { 
        setTimeout(() => sendOne(2), 5000); 
    }}, 4000);
    }

    const timer = setTimeout(() => {
    if (!found) {
        proc.kill('SIGTERM');
        console.error(`[AUTH] Timeout for ${userId}. Output so far: ${state.output.slice(-200)}`);
        res.status(500).json({ error: 'Auth link timeout', output: state.output.slice(-500) });
    }
    }, 35000);

    const onData = (data) => {
      const text = data.toString();
      // [DEBUG] Log raw output from Gemini CLI for debugging
      if (agent === 'gemini') {
          console.log(`[AUTH DEBUG] Gemini CLI raw output for ${userId}: ${text}`);
      }
      state.output += text;
      fs.appendFileSync(authLog, text); // Deep logging
      const cleaned = state.output.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
        
        // Match standard OAuth2 URL and Codex device code
        const urlMatch = cleaned.match(/https:\/\/(?:accounts\.google\.com|auth\.openai\.com|openai\.com)\/[^\s"']+/);
        const codeMatch = cleaned.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/);

        if (urlMatch && !found) {
            // Wait for code if it's codex device auth
            if (agent === 'codex' && !codeMatch) return; 
            
            found = true;
            clearTimeout(timer);
            let response = urlMatch[0];
            if (agent === 'codex') {
                // Append state parameter (userId) to the redirect URL
                const parsedUrl = new URL(urlMatch[0]);
                parsedUrl.searchParams.set('state', userId);
                response = parsedUrl.toString();
                if (codeMatch) {
                    response = `Ссылка: ${response}\nКод: ${codeMatch[0]}`;
                }
            }
            
            console.log(`[AUTH] Found URL for ${userId} (${agent})`);
            if (agent !== 'gemini' && agent !== 'codex') proc.kill();
            
            res.json({ auth_url: response });
        }
    };

    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
});

// Auth Submit (Gemini Code)
app.post('/v1/auth/submit', async (req, res) => {
    const userId = sanitizeUserId(req.body.user_id);
    let { code } = req.body;
    code = String(code || '').trim();
    console.log(`[AUTH] Submit code for ${userId}`);

    const state = geminiAuthProcesses.get(userId);
    if (!state) return res.status(404).json({ error: 'Auth process not found or expired' });

    console.log(`[AUTH] Writing code to stdin for ${userId}`);
    state.proc.stdin.write(`${code}\n`);
    
    // Polling for success (up to 20 seconds)
    const userDir = ensureUserDirs(userId);
    const credsFile = path.join(userDir, '.gemini', 'oauth_creds.json');
    let attempts = 0;

    const poll = setInterval(() => {
        attempts++;
        if (fs.existsSync(credsFile)) {
            clearInterval(poll);
            console.log(`[AUTH] Success for ${userId}! Credentials file created.`);
            res.json({ ok: true });
            try { state.proc.kill(); } catch(e) {}
            geminiAuthProcesses.delete(userId);
        } else if (attempts >= 120) { // 60 seconds
            clearInterval(poll);
            console.error(`[AUTH] Failed for ${userId} after 60s. File missing.`);
            // Log last output for debugging
            console.log(`[AUTH] CLI Output so far: ${state.output.slice(-300)}`);
            res.status(400).json({ error: 'Code not accepted by CLI or timeout' });
        }
    }, 500);
});

// Auth Callback for Codex CLI
app.get('/v1/auth/codex/callback', async (req, res) => {
    const { code, state: userId } = req.query; // Assuming 'state' parameter contains userId
    const sanitizedId = sanitizeUserId(userId);
    console.log(`[AUTH] Codex callback received for user ${sanitizedId} with code: ${code}`);

    if (!code || !sanitizedId) {
        return res.status(400).send('Authorization code or state (userId) missing.');
    }

    const authState = codexAuthProcesses.get(sanitizedId);
    if (!authState) {
        console.error(`[AUTH] Codex auth process not found or expired for user ${sanitizedId}`);
        return res.status(404).send('Authentication process not found or expired.');
    }

    // Write the code to the stdin of the waiting Codex CLI process
    console.log(`[AUTH] Writing code to stdin for Codex CLI for user ${sanitizedId}`);
    authState.proc.stdin.write(`${code}\n`);
    
    // Polling for success (e.g., a credential file created by Codex CLI)
    const userDir = ensureUserDirs(sanitizedId);
    // Assuming Codex CLI creates a credentials file, adjust path as needed
    const credsFile = path.join(userDir, '.codex', 'oauth_creds.json'); 
    let attempts = 0;

    const poll = setInterval(() => {
        attempts++;
        if (fs.existsSync(credsFile)) {
            clearInterval(poll);
            console.log(`[AUTH] Codex authentication success for user ${sanitizedId}!`);
            res.send('Authentication successful! You can close this window.');
            try { authState.proc.kill(); } catch(e) {}
            codexAuthProcesses.delete(sanitizedId);
        } else if (attempts >= 120) { // 60 seconds
            clearInterval(poll);
            console.error(`[AUTH] Codex authentication failed for user ${sanitizedId} after 60s.`);
            res.status(400).send('Authentication timed out or failed to complete.');
        }
    }, 500);
});

// Chat Completions
app.post('/v1/chat/completions', async (req, res) => {
    if (!req.body || !Array.isArray(req.body.messages) || req.body.messages.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
    }
    const { messages, temperature } = req.body;
    const reqAgent = req.body.agent || req.body.model;
    const userId = sanitizeUserId(req.body.user_id || (isLocalRequest(req) ? "945996850" : undefined));
    const agentState = resolveAgentState(userId, reqAgent);
    const agent = agentState.agent;
    const prompt = messages[messages.length - 1].content;
    const finalTemp = temperature !== undefined ? temperature : 0.7;

    console.log(`[CHAT] User ${userId} via ${agent} (${agentState.source}, temp: ${finalTemp}): ${prompt.slice(0, 30)}...`);
    const userDir = ensureUserDirs(userId);

    // Save user message to history
    globalChatHistory.push({
        id: 'user-' + Date.now(),
        sender: 'user',
        text: prompt,
        timestamp: new Date().toLocaleTimeString()
    });

    if (agent === 'openrouter') {
        try {
            console.log(`[CHAT] Calling OpenRouter for ${userId} with model ${OPENROUTER_DEFAULT_MODEL}`);
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'http://localhost:18082',
                    'X-Title': 'SmartWeb Jarvis'
                },
                body: JSON.stringify({
                    model: OPENROUTER_DEFAULT_MODEL,
                    messages: messages,
                    temperature: finalTemp
                })
            });
            const data = await response.json();
            if (data.error) {
                console.error(`[CHAT] OpenRouter Error: ${JSON.stringify(data.error)}`);
                // Fallback to a very safe model if primary fails
                if (OPENROUTER_DEFAULT_MODEL !== 'mistralai/mistral-7b-instruct:free') {
                    console.log(`[CHAT] Trying fallback model: mistralai/mistral-7b-instruct:free`);
                    const fallbackResp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${OPENROUTER_API_KEY}`
                        },
                        body: JSON.stringify({
                            model: 'mistralai/mistral-7b-instruct:free',
                            messages: messages,
                            temperature: finalTemp
                        })
                    });
                    const fallbackData = await fallbackResp.json();
                    return res.json({ choices: [{ message: { role: 'assistant', content: fallbackData.choices?.[0]?.message?.content || `Ошибка OpenRouter: ${data.error.message}` } }] });
                }
                return res.status(500).json({ error: `OpenRouter error: ${data.error.message}` });
            }
            const reply = data.choices?.[0]?.message?.content || 'OpenRouter не вернул ответ.';
            return res.json({ choices: [{ message: { role: 'assistant', content: reply } }] });
        } catch (e) {
            console.error(`[CHAT] OpenRouter Exception: ${e.message}`);
            return res.status(500).json({ error: `OpenRouter error: ${e.message}` });
        }
    }

    if (agent === 'xiaomi') {
        try {
            console.log(`[CHAT] Calling Xiaomi (MiMo) via OpenRouter for ${userId} with model ${XIAOMI_MODEL}`);
            const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                    'HTTP-Referer': 'http://localhost:18088',
                    'X-Title': 'SmartWeb Jarvis'
                },
                body: JSON.stringify({
                    model: XIAOMI_MODEL,
                    messages: messages,
                    temperature: finalTemp
                })
            });
            const data = await response.json();
            console.log(`[CHAT] Xiaomi Response: ${JSON.stringify(data)}`);
            if (data.error) {
                console.error(`[CHAT] Xiaomi Error: ${JSON.stringify(data.error)}`);
                return res.status(500).json({ error: `Xiaomi error: ${data.error.message}` });
            }
            const reply = data.choices?.[0]?.message?.content || 'Xiaomi не вернул ответ.';
            return res.json({ choices: [{ message: { role: 'assistant', content: reply } }] });
        } catch (e) {
            console.error(`[CHAT] Xiaomi Exception: ${e.message}`);
            return res.status(500).json({ error: `Xiaomi error: ${e.message}` });
        }
    }

    if (agent === 'ollama' || agent === 'gemma') {
        try {
            const model = agent === 'gemma' ? GEMMA_DEFAULT_MODEL : OLLAMA_DEFAULT_MODEL;
            const response = await fetch(`${OLLAMA_HOST}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model,
                    messages: messages,
                    stream: false,
                    options: {
                        temperature: finalTemp
                    }
                })
            });
            const data = await response.json();
            return res.json({ choices: [{ message: { role: 'assistant', content: data.message?.content || 'Ollama error' } }] });
        } catch (e) {
            return res.status(500).json({ error: `Ollama error: ${e.message}` });
        }
    }

    // CLI Agents (Gemini / Codex)
    const bin = agent === 'codex' ? CODEX_BIN : GEMINI_BIN;
    
    // Improved prompt construction: placement AT THE END is often more effective for CLI agents
    let fullPrompt = '';
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
        fullPrompt = `${prompt}\n\n[SYSTEM INSTRUCTION: ${systemMsg.content} IMPORTANT: ALWAYS ANSWER IN RUSSIAN LANGUAGE!]`;
    } else {
        fullPrompt = prompt;
    }

    const args = agent === 'codex'
        ? ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
        : ['--skip-trust', '--yolo'];

    console.log(`[CHAT] Spawning agent: ${bin} with args: ${args.join(' ')} (shell: ${IS_WINDOWS})`);
    const proc = spawn(bin, args, {
        cwd: userDir,
        env: getIsolatedEnv(userId, agent),
        shell: IS_WINDOWS
    });

    proc.on('error', (err) => {
        console.error(`[CHAT] Spawn Error: ${err.message}`);
    });

    if (fullPrompt) {
        proc.stdin.write(fullPrompt);
        proc.stdin.end();
    }

    let stdout = '', stderr = '';
    proc.stdout.on('data', (d) => stdout += d.toString());
    proc.stderr.on('data', (d) => stderr += d.toString());

    let finished = false;

    const timeout = setTimeout(() => {
        if (!finished) {
            finished = true;
            proc.kill();
            res.json({ choices: [{ message: { role: 'assistant', content: 'Ошибка: превышено время ожидания ответа от CLI.' } }] });
        }
    }, 150000);

    proc.on('close', (code) => {
        if (!finished) {
            finished = true;
            clearTimeout(timeout);
            let output = cleanCliOutput(stdout || stderr, agent);
            
            if (output.includes('Manual authorization is required') || output.includes('Login required')) {
                return res.json({ choices: [{ message: { role: 'assistant', content: '⚠️ Агент не авторизован. Пожалуйста, пройдите авторизацию в меню бота.' } }] });
            }

            // FINAL GUARD: If output is purely ASCII (English) but we asked for Russian
            const isEnglish = /^[a-zA-Z0-9\s.,!?'"()-]+$/.test(output);
            if (isEnglish && output.length > 10) {
                output = "[ Jarvis Note: Был получен ответ на английском, перевожу на русский... ]\n\n" + output;
            }

            const reply = output || 'Агент не вернул текст.';
            
            // Save reply to history
            globalChatHistory.push({
                id: 'jarvis-' + Date.now(),
                sender: 'jarvis',
                text: reply,
                timestamp: new Date().toLocaleTimeString()
            });
            if (globalChatHistory.length > 50) globalChatHistory.shift();

            res.json({ choices: [{ message: { role: 'assistant', content: reply } }] });
        }
    });
});

// === MANAGEMENT API (DASHBOARD) ===

// Open Browser
app.get('/api/system/open-browser', (req, res) => {
    const url = req.query.url || 'http://google.com';
    const cmd = IS_WINDOWS 
        ? 'start' 
        : '/mnt/c/WINDOWS/system32/cmd.exe';
    const args = IS_WINDOWS 
        ? ['chrome', `"${url}"`] 
        : ['/c', 'start', '""', `"${url}"`];
    
    console.log(`[SYSTEM] Spawning browser command: ${cmd} ${args.join(' ')}`);

    try {
        const proc = spawn(cmd, args, {
            detached: true,
            shell: true,
            stdio: 'ignore' // Detach stdio
        });

        proc.on('error', (err) => {
            console.error(`[SYSTEM] Failed to start browser: ${err.message}`);
            // We might have already sent a response, so check
            if (!res.headersSent) {
                res.status(500).json({ ok: false, error: err.message });
            }
        });

        // Unreference the child process to allow the parent to exit independently
        proc.unref();

        // Immediately respond to the client
        res.json({ ok: true, message: 'Browser launch initiated' });

    } catch (err) {
        console.error(`[SYSTEM] Spawn failed catastrophically: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).json({ ok: false, error: `Spawn failed: ${err.message}` });
        }
    }
});

// Open VS Code
app.get('/api/system/open-vscode', (req, res) => {
    const cmd = IS_WINDOWS ? 'code .' : 'code .';
    exec(cmd, { cwd: USERS_ROOT }, (err) => {
        res.json({ ok: !err, error: err ? err.message : null });
    });
});

// Execute arbitrary command
app.post('/api/system/execute', (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const { command } = req.body;
    if (!command) return res.status(400).json({ error: 'No command provided' });

    console.log(`[SYSTEM] Executing command: ${command}`);
    // Use powershell on windows for better compatibility
    const shell = IS_WINDOWS ? 'powershell.exe' : '/bin/bash';
    const shellArgs = IS_WINDOWS ? ['-NoProfile', '-Command', command] : ['-c', command];

    exec(`${shell} ${shellArgs.join(' ')}`, (err, stdout, stderr) => {
        res.json({ 
            ok: !err, 
            stdout: stdout.trim(), 
            stderr: stderr.trim(),
            error: err ? err.message : null 
        });
    });
});

// Users Count
app.get('/api/system/users-count', (req, res) => {
    try {
        const count = fs.readdirSync(USERS_ROOT).filter(f => fs.statSync(path.join(USERS_ROOT, f)).isDirectory()).length;
        res.json({ count });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// User Scripts
app.get('/api/user/scripts', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || '945996850');
    try {
        const registry = syncUserScriptWorkspace(userId);
        res.json({ ok: true, user_id: userId, count: registry.count, scripts: registry.scripts, registry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/user/agents', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || '945996850');
    try {
        const registry = getUserAgentsRegistry(userId);
        res.json({ ok: true, user_id: userId, count: registry.agents.length, active_agent: registry.active_agent, role: registry.role, agents: registry.agents, registry });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/system/hub', (req, res) => {
    if (!isAdminRequest(req)) {
        return res.status(403).json({ error: 'Forbidden' });
    }
    try {
        const hub = ensureScriptHub();
        res.json({ ok: true, hub });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// User Profile
app.get('/api/user/profile', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || '945996850');
    const profilePath = path.join(ensureUserDirs(userId), 'profile.json');
    try {
        const profile = fs.existsSync(profilePath) 
            ? JSON.parse(fs.readFileSync(profilePath, 'utf8')) 
            : { reputation: 1250, sbt_level: 'Silver' }; // Mock data if not exists
        res.json(profile);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Paperclip user workspace bridge. Telegram WebApp can call this with tg_user_id
// and receive the isolated folder + active agent state owned by that user.
app.get('/api/user/workspace', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || req.query.tg_user_id || '945996850');
    const workspace = getUserWorkspace(userId);
    const userDir = workspace.server_path;
    const goalsPath = path.join(userDir, 'goals.md');
    const profilePath = path.join(userDir, 'profile.json');
    let profile = {};
    try {
        if (fs.existsSync(profilePath)) profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    } catch (e) {
        profile = {};
    }
    res.json({
        ok: true,
        user_id: userId,
        agent: resolveAgentForUser(userId),
        agent_state: resolveAgentState(userId),
        workspace: {
            ...workspace,
            tools_dir: path.join(userDir, 'agents'),
            bots_dir: path.join(userDir, 'bots'),
            scripts_dir: path.join(userDir, 'scripts'),
            registry_dir: path.join(userDir, 'registry')
        },
        registry: ensureWorkspaceRegistry(userId),
        goals_markdown: fs.existsSync(goalsPath) ? fs.readFileSync(goalsPath, 'utf8') : '',
        profile
    });
});

// User Goals
app.get('/api/user/goals', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || '945996850');
    const goalsPath = path.join(ensureUserDirs(userId), 'goals.md');
    // Simplified goals for UI testing
    res.json({ 
        global: [
            { 
                title: 'Освоение SmartWeb 3.0', 
                progress: 65,
                medium: [
                    { title: 'Автоматизация YouTube', progress: 80, short: [{title: 'Загрузить 10 видео', completed: true}] },
                    { title: 'Голосовое управление', progress: 30, short: [{title: 'Настроить Whisper', completed: false}] }
                ]
            }
        ] 
    });
});


// === HERMES ROUTER ===
app.get('/api/hermes/status', (req, res) => {
    const userId = sanitizeUserId(req.query.user_id || '945996850');
    const office = ensurePaperclipMirror(userId);
    const agentState = resolveAgentState(userId);
    const registry = ensureWorkspaceRegistry(userId);
    res.json({
        ok: true,
        mode: 'internal-router',
        role: getUserRole(userId),
        agent: agentState.agent,
        agent_state: agentState,
        free_user_agents: Array.from(FREE_USER_AGENTS),
        paperclip: office,
        registry,
        services: {
            orchestrator: `http://127.0.0.1:${PORT}`,
            paperclip: PAPERCLIP_API_URL
        }
    });
});

app.post('/api/hermes/route', async (req, res) => {
    const body = req.body || {};
    const userId = sanitizeUserId(body.user_id || '945996850');
    const event = body.event || 'message';
    const payload = body.payload || {};
    const prompt = String(payload.prompt || body.prompt || '').trim();
    const role = getUserRole(userId);
    const agentState = resolveAgentState(userId, body.agent);
    const agent = agentState.agent;
    const office = ensurePaperclipMirror(userId);
    appendUserLog(userId, 'hermes_router.jsonl', { event, role, agent, payload: { ...payload, prompt: prompt.slice(0, 500) } });

    if (event === 'office.ensure') {
        return res.json({ ok: true, action: 'office_ready', role, agent, agent_state: agentState, paperclip: office });
    }

    if (event === 'agent.activate') {
        const requestedAgent = String(payload.agent || body.agent || '').trim();
        if (!['gemini', 'codex', 'openrouter', 'ollama', 'gemma', 'xiaomi'].includes(requestedAgent)) {
            return res.status(400).json({ ok: false, error: 'Invalid agent' });
        }
        const active = setPaperclipActiveAgent(userId, requestedAgent, payload.source || 'paperclip');
        setUserAgent(userId, active.agent);
        const updatedOffice = ensurePaperclipMirror(userId);
        appendUserLog(userId, 'hermes_router.jsonl', { event: 'agent.activated', active });
        return res.json({ ok: true, action: 'agent_activated', role, agent: active.agent, active, paperclip: updatedOffice });
    }

    if (event === 'paperclip.task') {
        const taskDir = path.join(ensureUserDirs(userId), 'tasks');
        fs.mkdirSync(taskDir, { recursive: true });
        const taskId = `task_${Date.now()}`;
        const taskPath = path.join(taskDir, `${taskId}.md`);
        const task = {
            task_id: taskId,
            user_id: userId,
            role,
            agent,
            title: payload.title || 'Telegram task',
            source: payload.source || 'smartweb30',
            prompt: prompt || payload.description || '',
            status: 'queued',
            created_at: new Date().toISOString(),
            office
        };
        fs.writeFileSync(taskPath, `# ${task.title}\n\nUser: ${userId}\nRole: ${role}\nAgent: ${agent}\nSource: ${task.source}\nStatus: queued\n\n${task.prompt}\n`, 'utf8');
        appendUserLog(userId, 'paperclip_queue.jsonl', { ...task, task_path: taskPath });

        let paperclipApi = null;
        try {
            const response = await fetch(`${PAPERCLIP_API_URL}/api/smartweb/tasks`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(task),
                timeout: 5000
            });
            const text = await response.text();
            paperclipApi = { status: response.status, ok: response.ok, body: text.slice(0, 1000) };
        } catch (e) {
            paperclipApi = { ok: false, error: e.message };
        }

        return res.json({ ok: true, action: 'queued_for_paperclip', task_id: taskId, task_path: taskPath, role, agent, agent_state: agentState, paperclip: office, paperclip_api: paperclipApi });
    }

    if (event === 'message') {
        if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });
        const username = payload.username || body.username || 'User';
        const system = payload.system || `You are Hermes, the internal orchestrator for SmartWeb30. SmartWeb30 is only the Telegram/frontend transport. Route work through Paperclip offices, Obsidian/Vault user workspaces, and the selected agent policy. User role: ${role}. Active agent: ${agent}. Answer in Russian.`;
        const timeoutMs = Math.max(10000, Number(process.env.HERMES_ROUTE_TIMEOUT_MS || payload.timeout_ms || 90000));
        const temperature = payload.temperature ?? body.temperature ?? 0.7;
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: prompt }
        ];
        const directChatBody = { user_id: userId, username, agent, temperature, messages };
        try {
            let response = null;
            let data = null;
            let routeBackend = 'direct-js-router';

            if (process.env.SMARTWEB_HERMES_GATEWAY_ENABLED !== '0') {
                const hermesController = new AbortController();
                const hermesTimer = setTimeout(() => hermesController.abort(), timeoutMs);
                try {
                    response = await fetch(`${HERMES_GATEWAY_URL}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: hermesController.signal,
                        body: JSON.stringify({
                            model: 'hermes-agent',
                            temperature,
                            messages,
                            metadata: { user_id: userId, username, agent, source: 'smartweb30-orchestrator' }
                        })
                    });
                    data = await response.json();
                    routeBackend = 'hermes-gateway';
                    if (!response.ok) {
                        appendUserLog(userId, 'hermes_router.jsonl', { event: 'message.hermes_gateway_non_ok', status: response.status, body: JSON.stringify(data).slice(0, 500) });
                        response = null;
                        data = null;
                    }
                } catch (e) {
                    appendUserLog(userId, 'hermes_router.jsonl', { event: 'message.hermes_gateway_failed', error: e.name === 'AbortError' ? `Hermes gateway timed out after ${timeoutMs}ms` : e.message });
                    response = null;
                    data = null;
                } finally {
                    clearTimeout(hermesTimer);
                }
            }

            if (!response || !data) {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        signal: controller.signal,
                        body: JSON.stringify(directChatBody)
                    });
                    data = await response.json();
                    routeBackend = 'direct-js-router';
                } finally {
                    clearTimeout(timer);
                }
            }

            const reply = data.choices?.[0]?.message?.content || data.error || 'Hermes did not return a response.';
            appendUserLog(userId, 'hermes_router.jsonl', { event: 'message.completed', role, agent, backend: routeBackend, reply: String(reply).slice(0, 500) });
            return res.status(response.ok ? 200 : 502).json({ ok: response.ok, action: 'message_completed', role, agent, backend: routeBackend, agent_state: agentState, paperclip: office, reply, raw: data });
        } catch (e) {
            appendUserLog(userId, 'hermes_router.jsonl', { event: 'message.failed', role, agent, error: e.message });
            return res.status(502).json({ ok: false, action: 'message_failed', role, agent, error: e.name === 'AbortError' ? `Hermes route timed out after ${timeoutMs}ms` : e.message });
        }
    }

    return res.json({ ok: true, action: 'event_logged', event, role, agent, agent_state: agentState, paperclip: office });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Jarvis Orchestrator v2.1 live on port ${PORT}`);
});
