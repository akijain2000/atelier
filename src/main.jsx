import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { getToken } from './lib/auth.js';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import AttentionQueue from './components/AttentionQueue.jsx';
import FilteredLeads from './components/FilteredLeads.jsx';
import AllConversations from './components/AllConversations.jsx';
import ConversationView from './pages/ConversationView.jsx';
import './styles.css';

function RequireAuth({ children }) {
  return getToken() ? children : <Navigate to="/login" replace />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><Dashboard /></RequireAuth>}>
          <Route index element={<AttentionQueue />} />
          <Route path="filtered" element={<FilteredLeads />} />
          <Route path="all" element={<AllConversations />} />
          <Route path="conversation/:id" element={<ConversationView />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
