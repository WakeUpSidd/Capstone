import axios from 'axios';

// In dev we can rely on Vite's proxy (`/api` -> backend). In production, `/api`
// is not automatically proxied by static hosting, so you MUST provide the full backend base URL
// at build time via `VITE_API_BASE_URL` (e.g. https://your-backend.onrender.com/api).
const RAW_API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

function normalizeApiBaseUrl(raw) {
  if (!raw) return '/api';
  const trimmed = String(raw).trim();

  // If an absolute URL is provided, normalize the pathname.
  try {
    const u = new URL(trimmed);
    let path = (u.pathname || '/').replace(/\/+$/, '');

    // Accept either https://host or https://host/api; always target /api.
    if (!path.endsWith('/api')) {
      path = path === '' ? '/api' : `${path}/api`;
    }

    u.pathname = path;
    return u.toString().replace(/\/+$/, '');
  } catch (_) {
    // If a non-URL string was provided, fall back to string manipulation.
    const noTrailing = trimmed.replace(/\/+$/, '');
    return noTrailing.endsWith('/api') ? noTrailing : `${noTrailing}/api`;
  }
}

const API_BASE_URL = normalizeApiBaseUrl(RAW_API_BASE_URL);

// Create axios instance with default configuration
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 10000,
  // Don't force a global Content-Type. Let axios/browser set it per request.
  // (This is critical for FormData uploads so the multipart boundary is correct.)
  headers: {},
  withCredentials: true, // Important for sending cookies
});

// Request interceptor to add auth token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // If this request is sending FormData, ensure we don't pin Content-Type.
    // The browser will add the correct multipart boundary.
    if (typeof FormData !== 'undefined' && config.data instanceof FormData) {
      if (config.headers) {
        delete config.headers['Content-Type'];
        delete config.headers['content-type'];
      }
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor for error handling
api.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    if (error.response?.status === 401) {
      // Only redirect if this is an authenticated request (has Authorization header)
      // Don't redirect on login/register failures
      const isAuthenticatedRequest = error.config?.headers?.Authorization;
      
      if (isAuthenticatedRequest) {
        // Token expired or invalid - redirect to login
        localStorage.removeItem('authToken');
        localStorage.removeItem('user');
        window.location.href = '/';
      }
    }
    return Promise.reject(error);
  }
);

// Auth API functions
export const authApi = {
  // User authentication
  registerUser: (userData) => api.post('/users/register', userData),
  verifyUser: (verificationData) => api.post('/users/verify-email', verificationData),
  loginUser: (credentials) => api.post('/users/login', credentials),
  logoutUser: () => api.post('/users/logout'),
  
  // Organization authentication
  registerOrganization: (orgData) => api.post('/organizations/register', orgData),
  loginOrganization: (credentials) => api.post('/organizations/login', credentials),
};

// User API functions
export const userApi = {
  getUsers: () => api.get('/users'),
  getUserById: (id) => api.get(`/users/${id}`),
};

// Organization API functions
export const organizationApi = {
  getOrganizations: () => api.get('/organizations'),
  getOrganization: (id) => api.get(`/organizations/${id}`),
  updateOrganization: (id, data) => api.put(`/organizations/${id}`, data),
  deleteOrganization: (id) => api.delete(`/organizations/${id}`),
  getAllMembers: (id) => api.get(`/organizations/${id}/members`),
};

// Team API functions
export const teamApi = {
  // Backend routes mounted at /api/teams
  // List teams the authenticated user belongs to
  getTeams: () => api.get('/teams'),
  // Get a specific team (populates members)
  getTeam: (id) => api.get(`/teams/${id}`),
  // Create team (backend expects /create)
  createTeam: (teamData) => api.post('/teams/create', teamData),
  // Delete team
  deleteTeam: (id) => api.delete(`/teams/${id}`),
  // Membership management (must be team_admin)
  addMember: (teamId, memberData) => api.put(`/teams/${teamId}/add-member`, memberData),
  removeMember: (teamId, payload) => api.put(`/teams/${teamId}/remove-member`, payload),
  changeAdmin: (teamId, payload) => api.patch(`/teams/${teamId}/change-admin`, payload),
  changeAccess: (teamId, payload) => api.patch(`/teams/${teamId}/change-access`, payload),
};

// Project API functions
export const projectApi = {
  getProjects: () => api.get('/projects'),
  createProject: (projectData) => api.post('/projects', projectData),
  getProject: (id) => api.get(`/projects/${id}`),
  updateProject: (id, data) => api.put(`/projects/${id}`, data),
  deleteProject: (id) => api.delete(`/projects/${id}`),
  // Datasets per project
  listDatasets: (projectId) => api.get(`/projects/${projectId}/datasets`),
  uploadDatasets: (projectId, files) => { 
    const form = new FormData();  
    Array.from(files || []).forEach((file) => form.append('files', file));
    // Uploads can take longer on Render (cold starts / limited CPU / large CSVs).
    return api.post(`/projects/${projectId}/datasets`, form, { timeout: 300000 });
  },
};

// Chat API functions
export const chatApi = {
  // Create an empty chat for a project
  createEmptyChat: (projectId) => api.post('/chat/create', { projectId }),
  // Get chat history for a given project/chat
  getChatHistory: (projectId, chatId) => api.get(`/chat/${projectId}/${chatId}`),
  // Send a user message (optionally with files and selected dataset IDs)
  sendUserMessage: ({ projectId, chatId, content, files, selectedDatasetIds }) => {
    const form = new FormData();
    if (files && files.length) {
      Array.from(files).forEach((f) => form.append('files', f));
    }
    if (content) form.append('content', content);
    if (chatId) form.append('chatId', chatId);
    if (projectId) form.append('projectId', projectId);
    if (selectedDatasetIds && selectedDatasetIds.length) {
      // Send as a simple JSON string or comma-separated list; backend reads req.body
      form.append('selectedDatasets', JSON.stringify(selectedDatasetIds));
    }
    // Endpoint is /api/chat (router.use('/api/chat', chatRouter) + router.post('/', ...))
    return api.post('/chat', form, { timeout: 300000 });
  },
  // Ask AI to reply using existing chat context
  // NOTE: backend mounts chat router at /api/chat and defines route as POST /ai,
  // so the full path is /api/chat/ai here.
  // Report generation (profile intent) can take >60s on Render (cold starts / limited CPU),
  // so use a longer timeout.
  aiReply: ({ projectId, chatId, content }) =>
    api.post('/chat/ai', { projectId, chatId, content }, { timeout: 300000 }),
  // Rename a chat (server-side persistence)
  renameChat: ({ projectId, chatId, title }) => api.patch('/chat/rename', { projectId, chatId, title }),
	// Bandit feedback for the LLM arm used (includes messageId for persistence)
	submitFeedback: ({ armId, reward, messageId }) => api.post('/chat/feedback', { arm_id: armId, reward, messageId }),
};

export default api;