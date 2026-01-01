import React, { useEffect, useRef, useState } from 'react';
import Plot from 'react-plotly.js';
import AppHeader from '../components/AppHeader.jsx';
import { chatApi, projectApi } from '../services/api';

const userStr = localStorage.getItem('user');
const me = userStr ? JSON.parse(userStr) : null;
const myName = me?.name || '';
const myEmail = me?.email || '';
const myDisplayName = (myName || myEmail || 'User').trim();
const myInitial = (myDisplayName?.[0] || 'U').toUpperCase();

/**
 * Mock Icon Components
 */
const IconSend = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L6 12Zm0 0h7.5" />
  </svg>
);

const IconBot = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
     <path strokeLinecap="round" strokeLinejoin="round" d="M15.182 15.182a4.5 4.5 0 0 1-6.364 0M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 6.75h.008v.008H12v-.008Z" />
   </svg>
);

// FIXED: Using the correct "paper-clip" icon path
const IconPaperclip = ({ className }) => (
  <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
    <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-6.364 0 4.5 4.5 0 010-6.364l8.311-8.31a.75.75 0 011.06 1.06l-8.31 8.31a3 3 0 000 4.243 3 3 0 004.242 0l8.31-8.31-.001.002z" />
  </svg>
);


/**
 * Mock API Object
 */
const mockApi = (data, delay = 300) => new Promise((resolve) => setTimeout(() => resolve({ data }), delay));


// ----------------------------------------------------------------------
// CHATPAGE COMPONENT
// ----------------------------------------------------------------------

export default function ChatPage({ onLogout, navigateTo, selectedProjectId, setSelectedProjectId }) {
  const [projects, setProjects] = useState([]);
  const [projectChats, setProjectChats] = useState([]);
  const [activeChat, setActiveChat] = useState(null);
  const [activeChatHasContext, setActiveChatHasContext] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [attachFiles, setAttachFiles] = useState([]);
  const [showNewChatModal, setShowNewChatModal] = useState(false);
  const [modalDatasets, setModalDatasets] = useState([]);
  const [modalSelectedIds, setModalSelectedIds] = useState([]);
  const [modalUploading, setModalUploading] = useState(false);
  const [modalError, setModalError] = useState('');
  const chatEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const modalFileInputRef = useRef(null); // Ref for modal file input

  const submitFeedbackForMessage = async (messageIndex, reward) => {
    const msg = messages?.[messageIndex];
    const armId = msg?.armId;
    const messageId = msg?.messageId;
    if (!armId) return;
    if (msg?.feedback === 'up' || msg?.feedback === 'down') return;

    // Optimistic UI
    setMessages((prev) => prev.map((m, i) => (i === messageIndex ? { ...m, feedback: reward === 1 ? 'up' : 'down' } : m)));
    try {
      const response = await chatApi.submitFeedback({ armId, reward, messageId });
      // If already rated, revert to the existing feedback from server
      if (response.data?.status === 'already_rated') {
        setMessages((prev) => prev.map((m, i) => (i === messageIndex ? { ...m, feedback: response.data.existingFeedback } : m)));
      }
    } catch (e) {
      console.error('Feedback submit failed', e);
      // Rollback on failure
      setMessages((prev) => prev.map((m, i) => (i === messageIndex ? { ...m, feedback: null } : m)));
    }
  };

  // Add this helper function somewhere in your file
function formatBotMessage(markdownText) {
  if (!markdownText) return ''; // Return empty string if text is null or undefined
  let html = markdownText;
  html = html.replaceAll(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  html = html.replaceAll(/\*([^*]+)\*/g, '<strong>$1</strong>');
  html = html.replaceAll('\n', '<br>');
  html = html.replaceAll(/-\s(.*?)(<br>|$)/g, '<li>$1</li>');

  return html;
}

  function PlotlyChart({ config }) {
    if (!config) {
      console.warn('PlotlyChart: No config provided');
      return (
        <div className="bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none p-4 w-full">
          <p className="text-sm text-gray-500">Chart configuration is missing.</p>
        </div>
      );
    }

    if (!config.data || !Array.isArray(config.data)) {
      console.warn('PlotlyChart: Invalid data structure', config);
      return (
        <div className="bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none p-4 w-full">
          <p className="text-sm text-gray-500">Chart data is invalid. Expected config.data to be an array.</p>
        </div>
      );
    }

    try {
      return (
        <div className="bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none p-4 w-full min-w-[400px]">
          <Plot
            data={config.data}
            layout={{
              ...config.layout,
              autosize: true,
              height: 450,
              width: undefined, // Let autosize handle width
              margin: { l: 60, r: 40, t: 60, b: 60 },
              font: { size: 12 },
              paper_bgcolor: 'rgba(0,0,0,0)',
              plot_bgcolor: 'rgba(0,0,0,0)',
            }}
            config={{
              displayModeBar: true,
              displaylogo: false,
              responsive: true,
              modeBarButtonsToRemove: ['lasso2d', 'select2d'],
            }}
            useResizeHandler={true}
            style={{ width: '100%', minWidth: '400px', height: '450px' }}
          />
        </div>
      );
    } catch (error) {
      console.error('PlotlyChart render error:', error);
      return (
        <div className="bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none p-4 w-full">
          <p className="text-sm text-red-500">Error rendering chart: {error.message}</p>
        </div>
      );
    }
  }

  function ProfileBubble({ url, pdfUrl }) {
    if (!url) return null;

    return (
      <div className="bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none p-4 w-full min-w-[400px]">
        <div className="flex flex-wrap gap-2">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
          >
            Download report
          </a>
        </div>
      </div>
    );
  }

  // Load projects on mount
  useEffect(() => { 
    (async () => {
      try {
        const { data } = await projectApi.getProjects();
        const list = (data?.projects || []).map((p) => ({
          _id: p._id,
          name: p.name,
          chats: p.chats || [],
        }));
        setProjects(list);
        // Initialize selected project
        if (!selectedProjectId && list.length) {
          setSelectedProjectId?.(list[0]._id);
        }
      } catch (e) {
        console.error('Failed to load projects', e);
      }
    })();
  }, []);

  // Load chats when project changes
  useEffect(() => {
    if (!selectedProjectId) return;
    (async () => {
      try {
        const { data } = await projectApi.getProject(selectedProjectId);
        const chats = data?.project?.chats || [];
        setProjectChats(chats);
        setActiveChat(null);
        setMessages([]);
      } catch (e) {
        console.error('Failed to load project', e);
      }
    })();
  }, [selectedProjectId]);

  // Scroll to bottom on new message
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const openNewChat = async () => {
    if (!selectedProjectId) return;
    try {
      const { data } = await projectApi.listDatasets(selectedProjectId);
      setModalDatasets(data?.datasets || []);
      setModalSelectedIds([]);
      setModalError('');
      setShowNewChatModal(true);
    } catch (e) {
      console.error('Failed to load datasets for new chat', e);
      setModalDatasets([]);
      setModalSelectedIds([]);
      setShowNewChatModal(true);
    }
  };

  const handleModalUpload = async (evt) => {
    const files = evt.target.files;
    if (!files || !files.length || !selectedProjectId) return;
    setModalError('');
    setModalUploading(true);
    try {
      // You might want to display file names here before uploading
      await projectApi.uploadDatasets(selectedProjectId, files);
      const { data } = await projectApi.listDatasets(selectedProjectId);
      setModalDatasets(data?.datasets || []);
    } catch (e) {
      const msg = e?.response?.data?.error || 'Upload failed.';
      setModalError(msg);
    } finally {
      setModalUploading(false);
      // Reset file input
      if (modalFileInputRef.current) modalFileInputRef.current.value = '';
    }
  };

  const confirmCreateChat = async () => {
    if (!selectedProjectId) return;
    try {
      const { data } = await chatApi.createEmptyChat(selectedProjectId);
      const chat = data?.chat;
      if (chat?._id) {
        // Persist selected datasets for this chat only
        const key = `selectedDatasets:${chat._id}`;
        localStorage.setItem(key, JSON.stringify(modalSelectedIds));
        setProjectChats((prev) => [...prev, chat]);
        setActiveChat(chat);
        setActiveChatHasContext(Array.isArray(modalSelectedIds) && modalSelectedIds.length > 0);
        setMessages([{ from: 'bot', text: 'New chat created. Ask your question to begin.' }]);
      }
    } catch (e) {
      console.error('Failed to create chat', e);
    } finally {
      setShowNewChatModal(false);
    }
  };

  const openChat = async (chat) => {
    setActiveChat(chat);
    try {
      const { data } = await chatApi.getChatHistory(selectedProjectId, chat._id);
      const rawMessages = (data?.chat?.messages || []);

      // Determine whether this chat already has dataset/file context persisted server-side
      const persistedHasContext = rawMessages.some((m) => {
        const hasSelected = Array.isArray(m.selectedDatasets) && m.selectedDatasets.length > 0;
        const hasFiles = Array.isArray(m.tempFiles) && m.tempFiles.some((f) => f && f.bufferBase64);
        return hasSelected || hasFiles;
      });

      // Also treat local storage selection as context (new chats may not have messages yet)
      let localHasSelection = false;
      try {
        const stored = localStorage.getItem(`selectedDatasets:${chat._id}`);
        if (stored) {
          const parsed = JSON.parse(stored);
          localHasSelection = Array.isArray(parsed) && parsed.length > 0;
        }
      } catch (_) {}

      setActiveChatHasContext(persistedHasContext || localHasSelection);

      const msgs = rawMessages.flatMap((m) => {
        if (m.sender === 'chatbot') {
          try {
            // The backend saves the raw JSON analysis in content
            const analysis = JSON.parse(m.content);
            const parts = [];
            // Read feedback and armId from the message document (persisted in DB)
            const feedbackFromDb = m.feedback || null; // 'up', 'down', or null
            const armIdFromDb = m.armId || analysis.arm_id || null;
            const messageIdFromDb = m._id || null;
            
            if (analysis.insights) {
					parts.push({ from: 'bot', type: 'text', text: analysis.insights, armId: armIdFromDb, messageId: messageIdFromDb, feedback: feedbackFromDb });
            }
            if (analysis.plotly) {
					parts.push({ from: 'bot', type: 'chart', chart: analysis.plotly, armId: armIdFromDb, messageId: messageIdFromDb, feedback: feedbackFromDb });
            }
              if (analysis.profile_url) {
					parts.push({ from: 'bot', type: 'profile', url: analysis.profile_url, pdfUrl: analysis.profile_pdf_url || null, armId: armIdFromDb, messageId: messageIdFromDb, feedback: feedbackFromDb });
              }
            if (analysis.error) {
					parts.push({ from: 'bot', type: 'text', text: `Error: ${analysis.error}`, armId: armIdFromDb, messageId: messageIdFromDb, feedback: feedbackFromDb });
            }
            return parts.length ? parts : [{ from: 'bot', type: 'text', text: 'No content.' }];
          } catch (e) {
            // Fallback for legacy plain text messages
            return [{ from: 'bot', type: 'text', text: m.content || '' }];
          }
        }
        return [{ from: 'user', text: m.content || '' }];
      });
      setMessages(msgs);
    } catch (e) {
      console.error('Failed to load chat history', e);
      setMessages([]);
      setActiveChatHasContext(false);
    }
  };

  const handleSend = async (e) => {
    e.preventDefault();
    if (!selectedProjectId || !activeChat?._id) return;
    const typed = input.trim();
    const hasFiles = (attachFiles && attachFiles.length > 0);
    // Retrieve dataset selection stored for this chat
    const dsKey = `selectedDatasets:${activeChat._id}`;
    let selectedDatasetIds = [];
    try {
      const stored = localStorage.getItem(dsKey);
      if (stored) selectedDatasetIds = JSON.parse(stored);
    } catch (_) {}
    const hasSelection = Array.isArray(selectedDatasetIds) && selectedDatasetIds.length > 0;

    // Our pipeline requires datasets or files. Allow chatting if this chat already has context.
    const hasContext = hasSelection || hasFiles || activeChatHasContext;
    if (!hasContext) {
      setMessages((prev) => [
        ...prev,
        { from: 'bot', text: 'Please select a dataset for this chat (or upload a CSV) before asking questions.' },
      ]);
      return;
    }
    const currentText = typed || 'Analyze these';
    setInput('');
    // Show the user's message (including the auto text)
    setMessages((prev) => [...prev, { from: 'user', text: currentText }]);

    try {
      await chatApi.sendUserMessage({
        projectId: selectedProjectId,
        chatId: activeChat._id,
        content: currentText,
        files: (attachFiles || []),
        selectedDatasetIds,
      });

      // Now that we've saved a message with datasets/files, the chat has persisted context
      if (hasSelection || hasFiles) setActiveChatHasContext(true);

      // During chat, if the user sent a message (typed or auto 'Analyze these'), always ask AI to reply
      const { data } = await chatApi.aiReply({ projectId: selectedProjectId, chatId: activeChat._id, content: currentText });
      
      const additions = [];
      // Handle new AnalysisResponse format from pipeline
      if (data) {
        // messageId comes from the backend now
        const messageId = data.messageId || null;
        const armId = data.arm_id || null;
        
        if (data.insights) {
				additions.push({ from: 'bot', type: 'text', text: data.insights, armId, messageId, feedback: null });
        }
        if (data.plotly) {
				additions.push({ from: 'bot', type: 'chart', chart: data.plotly, armId, messageId, feedback: null });
        }
        if (data.profile_url) {
				additions.push({ from: 'bot', type: 'profile', url: data.profile_url, pdfUrl: data.profile_pdf_url || null, armId, messageId, feedback: null });
        }
        if (data.error) {
				additions.push({ from: 'bot', type: 'text', text: `Error: ${data.error}`, armId, messageId, feedback: null });
        }
      }
      
      if (additions.length) setMessages((prev) => [...prev, ...additions]);
    } catch (e) {
      console.error('Message send failed', e);
      const msg =
        e?.response?.data?.error ||
        e?.response?.data?.detail ||
        e?.message ||
        'There was an error processing your message.';
      const hint = msg.includes('timeout') || e?.code === 'ECONNABORTED'
        ? ' (This can happen on Render for large reports. Try again, or reduce dataset size / set a lower ROW_LIMIT on FastAPI.)'
        : '';
      setMessages((prev) => [...prev, { from: 'bot', text: `Error: ${msg}${hint}` }]);
    }
    setAttachFiles([]);
    // Reset the file input so selecting the same file again triggers onChange
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="h-screen bg-gray-100 flex flex-col overflow-hidden">
      <AppHeader
        onLogout={onLogout}
        monochrome
        extraActions={(
          <button
            type="button"
            className="w-9 h-9 rounded-full bg-black text-white flex items-center justify-center text-sm font-semibold"
            onClick={() => navigateTo?.('userTeam')}
            title={myDisplayName}
            aria-label="Profile"
          >
            {myInitial}
          </button>
        )}
      />
      <div className="flex flex-1 overflow-hidden w-screen h-[calc(100vh-65px)] bg-gray-100">
        {/* Sidebar (ChatGPT-like) */}
        <div className="w-72 bg-gray-100 border-r border-gray-200 flex flex-col overflow-hidden p-3">
          <div className="mb-3">
            <label className="text-xs text-gray-600">Project</label>
            <select
              value={selectedProjectId || ''}
              onChange={(e) => setSelectedProjectId?.(e.target.value)}
              className="mt-1 w-full border border-gray-300 rounded-md px-2 py-1 text-sm"
            >
              {projects.map((p) => (
                <option key={p._id} value={p._id}>{p.name}</option>
              ))}
            </select>
          </div>

          <button
            onClick={openNewChat}
            className="mb-3 w-full py-2.5 flex justify-center items-center px-3 py-2 rounded-xl bg-black text-white text-sm hover:bg-gray-700 transition"
          >
            + New chat
          </button>

          {/* FIXED HERE: Changed h-0 to min-h-0 
            This allows the flex item to shrink below its content size, enabling overflow-y-auto to work.
          */}
          <div className="flex-1 overflow-y-auto space-y-1 pr-1 scrollbar-thin scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 min-h-0">
            {projectChats?.length ? (
              projectChats.map((c, idx) => (
                <button
                  key={c._id || idx}
                  onClick={() => openChat(c)}
                  className={`w-full text-left px-3 py-2 rounded text-sm ${activeChat?._id === c._id ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50 border border-transparent'}`}
                >
                  {c.title || `Chat ${idx + 1}`}
                </button>
              ))
            ) : (
              <p className="text-xs text-gray-500">No chats yet.</p>
            )}
          </div>

          <div className="mt-auto">
            <div className="pt-3 border-t border-gray-200 flex gap-2">
              <button
                className="flex-1 px-3 py-2 rounded border text-sm hover:bg-gray-50 text-center"
                onClick={() => navigateTo?.('userProjects')}
              >
                ← Projects
              </button>
              {/* Dataset selection is only offered at new chat creation time */}
              <button
                className="flex-1 px-3 py-2 rounded border text-sm hover:bg-gray-50 disabled:opacity-50 text-center"
                onClick={async () => {
                  if (!activeChat?._id || !selectedProjectId) return;
                  const current = projectChats.find((c) => c._id === activeChat._id);
                  const proposed = window.prompt('Rename chat', current?.title || '');
                  const title = (proposed || '').trim();
                  if (!title) return;
                  try {
                    const { data } = await chatApi.renameChat({ projectId: selectedProjectId, chatId: activeChat._id, title });
                    const updated = data?.chat;
                    if (updated?._id) {
                      setProjectChats((prev) => prev.map((c) => (c._id === updated._id ? { ...c, title: updated.title } : c)));
                      setActiveChat((prev) => (prev && prev._id === updated._id ? { ...prev, title: updated.title } : prev));
                    }
                  } catch (e) {
                    console.error('Rename failed', e);
                  }
                }}
                disabled={!activeChat?._id}
              >
                Rename
              </button>
            </div>

            <button
              type="button"
              onClick={() => navigateTo?.('userTeam')}
              className="mt-6 w-full flex items-center gap-3 px-3 py-1 rounded-md hover:bg-gray-50"
              aria-label="Profile"
            >
              <div className="w-10 h-10 rounded-full bg-black text-white flex items-center justify-center text-sm font-semibold shrink-0">
                {myInitial}
              </div>
              <div className="min-w-0 text-left">
                <div className="text-sm font-medium text-black truncate">{myDisplayName}</div>
                <div className="text-xs text-gray-500 truncate">{myEmail || ''}</div>
              </div>
            </button>
          </div>
        </div>

        {/* Main chat area */}
        <div className="flex-1 flex flex-col bg-gray-50 w-full">
          <div className="flex-1 overflow-y-auto p-6">
            {/* FIXED: Removed max-w-3xl from this container */}
            <div className="mx-auto space-y-4">
              {messages.map((msg, idx) => (
                <div key={idx} className={`flex ${msg.from === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`flex items-start gap-2 ${msg.type === 'chart' || msg.type === 'profile' ? 'max-w-[95%] w-full' : 'max-w-[80%]'}`}>
                    {msg.from === 'bot' && (
                      <div className="bg-gray-200 p-2 rounded-full flex-shrink-0">
                        <IconBot className="h-5 w-5 text-gray-600" />
                      </div>
                    )}
                    <div>
              {msg.type === 'chart' ? (
                <PlotlyChart config={msg.chart} />
              ) : msg.type === 'profile' ? (
                <ProfileBubble url={msg.url} pdfUrl={msg.pdfUrl} />
              ) : (
                <div className={`${msg.from === 'user' ? 'bg-white text-gray-800 rounded-2xl rounded-br-none shadow-sm' 
                : 'bg-white text-gray-800 border border-gray-200 rounded-2xl rounded-bl-none shadow-sm'} py-3 px-4 text-[15px] leading-relaxed`} 

                style={{ wordBreak: 'break-word' }}>
                {msg.from === 'bot' ? (
                  // For bot messages, render the formatted HTML
                  <div className="ml-2" dangerouslySetInnerHTML={{ __html: formatBotMessage(msg.text) }} />
                ) : (
                  // For user messages, render plain text as before
                  msg.text
                )}
              </div>
              )}

              {msg.from === 'bot' && msg.armId && (
                <div className="mt-2 flex items-center gap-2 text-xs text-gray-500">
                  <button
                    type="button"
                    className={`px-2 py-1 rounded border ${msg.feedback === 'up' ? 'bg-gray-100' : 'bg-white hover:bg-gray-50'}`}
                    onClick={() => submitFeedbackForMessage(idx, 1)}
                    disabled={msg.feedback === 'up' || msg.feedback === 'down'}
                  >
                    Helpful
                  </button>
                  <button
                    type="button"
                    className={`px-2 py-1 rounded border ${msg.feedback === 'down' ? 'bg-gray-100' : 'bg-white hover:bg-gray-50'}`}
                    onClick={() => submitFeedbackForMessage(idx, 0)}
                    disabled={msg.feedback === 'up' || msg.feedback === 'down'}
                  >
                    Not helpful
                  </button>
                </div>
              )}
            </div>
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
          </div>
          <form onSubmit={handleSend} className="border-t border-gray-200 p-4 bg-white">
            {/* FIXED: Removed max-w-3xl from this container */}
            <div className="mx-auto flex gap-2 items-center">
              
              {/* 1. New File Attach Button */}
              <button 
                type="button" 
                onClick={() => fileInputRef.current?.click()}
                className="p-3 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
                title="Attach files (chat-only; not saved to project)"
              >
                {/* FIXED: Added flex-shrink-0 to prevent icon distortion */}
                <IconPaperclip className="h-5 w-5 flex-shrink-0" />
              </button>
              
              {/* 2. Hidden File Input */}
              <input
                type="file"
                multiple
                ref={fileInputRef}
                onChange={(e) => setAttachFiles(Array.from(e.target.files || []))}
                className="hidden" // Input is now hidden
              />

              {/* 3. Text Input */}
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Send a message..."
                className="bg-[#E8EAED] flex-1 border border-gray-300 rounded-lg px-4 py-3 focus:ring-2 focus:ring-black outline-none text-sm"
              />
              
              {/* 4. Send Button */}
              <button type="submit" className="bg-black text-white rounded-lg px-5 py-3 flex items-center justify-center font-semibold hover:bg-blue-700">
                <IconSend className="h-5 w-5" />
              </button>
            </div>
            {/* Optional: Display attached file names */}
            {attachFiles.length > 0 && (
              // FIXED: Removed max-w-3xl from this container
              <div className="mx-auto mt-2 text-xs text-gray-500 px-2">
                <strong>Attached:</strong> {attachFiles.map(f => f.name).join(', ')}
              </div>
            )}
          </form>
        </div>
      </div>

      {/* New Chat modal: upload/select datasets only at creation time */}
      {showNewChatModal && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-lg w-full max-w-lg p-6">
            <h3 className="text-lg font-semibold text-gray-800">Start a new chat</h3>
            <p className="text-xs text-gray-500 mb-3">Optionally upload datasets to the project and select which ones this chat should use.</p>

            {/* --- MODAL FILE UPLOAD (STYLED) --- */}
            <div className="border rounded p-3 mb-3">
              <p className="text-sm font-medium text-gray-700">Upload datasets to project</p>
              
              {/* Hidden file input */}
              <input
                type="file"
                multiple
                onChange={handleModalUpload}
                className="hidden"
                ref={modalFileInputRef}
              />
              {/* Styled button to trigger file input */}
              <button
                type="button"
                onClick={() => modalFileInputRef.current?.click()}
                className="mt-2 w-full flex items-center justify-center gap-2 px-3 py-2 rounded border text-sm text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <IconPaperclip className="h-4 w-4 flex-shrink-0" />
                <span>Upload Files</span>
              </button>

              {modalUploading && <p className="text-xs text-blue-600 mt-2">Uploading…</p>}
              {modalError && <p className="text-xs text-red-600 mt-2">{modalError}</p>}
            </div>
            {/* --- END STYLED UPLOAD --- */}


            <div className="border rounded p-3 mb-3 max-h-60 overflow-y-auto">
              <p className="text-sm font-medium text-gray-700 mb-2">Select datasets for this chat</p>
              {modalDatasets.length ? (
                modalDatasets.map((d) => (
                  <label key={d._id || d.url} className="flex items-center gap-2 text-sm py-1">
                    <input
                      type="checkbox"
                      checked={modalSelectedIds.includes(d._id)}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setModalSelectedIds((prev) =>
                          checked ? [...prev, d._id] : prev.filter((id) => id !== d._id)
                        );
                      }}
                    />
                    <span className="truncate" title={d.name}>{d.name}</span>
                  </label>
                ))
              ) : (
                <p className="text-xs text-gray-500">No datasets uploaded yet.</p>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <button className="px-4 py-2 text-sm rounded border hover:bg-gray-50" onClick={() => setShowNewChatModal(false)}>Cancel</button>
              <button className="px-4 py-2 text-sm rounded bg-gray-600 text-white hover:bg-black" onClick={confirmCreateChat} disabled={!selectedProjectId}>Create chat</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}