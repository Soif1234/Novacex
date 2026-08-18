import { marketStore } from './store/marketStore';
import React, { useState, useEffect } from 'react';
import { BottomNav } from './components/BottomNav';
import { TopNav } from './components/TopNav';
import { Home } from './pages/Home';
import { Markets } from './pages/Markets';
import { SpotTrading } from './pages/SpotTrading';
import { Futures } from './pages/Futures';
import { Assets } from './pages/Assets';
import { Account } from './pages/Account';
import { Login } from './pages/Login';
import { Signup } from './pages/Signup';
import { Admin } from './pages/Admin';
import { useAuth } from './contexts/AuthContext';
import { priceAlertService } from './services/alerts/PriceAlertService';
import { notificationService } from './services/notifications/NotificationService';
import { futuresEngineService } from './services/futures/FuturesEngineService';
import { NotificationToaster } from './components/notifications/NotificationToaster';

import { ErrorBoundary } from './components/ErrorBoundary';

export default function App() {
  const [activeTab, setActiveTab] = useState('home');
  
  const { isAuthenticated } = useAuth();

  useEffect(() => {
    priceAlertService.initialize();
    notificationService.initialize();
    futuresEngineService.start();
  }, []);

  const handleNavigate = (tab: string, symbol?: string) => {
    if (symbol) {
      marketStore.setSelectedSymbol(symbol);
    }
    setActiveTab(tab);
  };

  const renderPage = () => {
    switch (activeTab) {
      case 'home':
        return <Home onNavigate={handleNavigate} />;
      case 'markets':
        return <Markets onNavigate={handleNavigate} />;
      case 'trade':
        return isAuthenticated ? <SpotTrading onNavigate={handleNavigate} /> : <Login onNavigate={handleNavigate} returnTab="trade" />;
      case 'futures':
        return isAuthenticated ? <Futures onNavigate={handleNavigate} /> : <Login onNavigate={handleNavigate} returnTab="futures" />;
      case 'assets':
        return isAuthenticated ? <Assets /> : <Login onNavigate={handleNavigate} returnTab="assets" />;
      case 'account':
        return isAuthenticated ? <Account onNavigate={handleNavigate} /> : <Login onNavigate={handleNavigate} returnTab="account" />;
      case 'admin':
        return isAuthenticated ? <Admin onNavigate={handleNavigate} /> : <Login onNavigate={handleNavigate} returnTab="admin" />;
      case 'login':
        return <Login onNavigate={handleNavigate} />;
      case 'signup':
        return <Signup onNavigate={handleNavigate} />;
      default:
        return <Home onNavigate={handleNavigate} />;
    }
  };

  return (
    <div className="min-h-screen bg-black text-gray-100 font-sans selection:bg-blue-500/30 flex justify-center">
      <main className="w-full max-w-md bg-gray-950 min-h-screen relative shadow-2xl flex flex-col border-x border-gray-900 overflow-hidden tabular-nums">
        <NotificationToaster />
        {activeTab !== 'account' && activeTab !== 'admin' && <TopNav onAccountClick={() => setActiveTab('account')} />}
        
        <div className="flex-1 overflow-y-auto hide-scrollbar">
          <ErrorBoundary>
            {renderPage()}
          </ErrorBoundary>
        </div>
        
        {activeTab !== 'admin' && <BottomNav activeTab={activeTab} onChange={setActiveTab} />}
      </main>
    </div>
  );
}

