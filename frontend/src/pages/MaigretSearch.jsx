import React from 'react';
import { UserSearch } from 'lucide-react';

const MaigretSearch = () => {
  // Use environment variable or fallback to same host but port 8008
  const webUrl = process.env.REACT_APP_MAIGRET_WEB_URL || `${window.location.protocol}//${window.location.hostname}:8008`;

  return (
    <div className="p-6 max-w-7xl mx-auto h-[calc(100vh-100px)] flex flex-col">
      <div className="mb-6 flex-shrink-0">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <UserSearch className="text-indigo-500" />
          Maigret Object Search
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Collect a dossier on a person by username across multiple platforms.
        </p>
      </div>

      <div className="flex-1 bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 overflow-hidden relative min-h-[600px]">
        <iframe 
          src={webUrl}
          title="Maigret Web Interface"
          className="w-full h-full border-0 absolute inset-0 text-white bg-transparent"
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads"
        />
      </div>
    </div>
  );
};

export default MaigretSearch;
