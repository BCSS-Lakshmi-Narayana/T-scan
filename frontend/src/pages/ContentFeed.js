import React, { useState, useEffect } from 'react';
import api from '../lib/api';
import { RefreshCw } from 'lucide-react';
import { Card } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { toast } from 'sonner';
import ContentCard from '../components/ContentCard';

const ContentFeed = () => {
  const [content, setContent] = useState([]);
  const [loading, setLoading] = useState(true);
  const [platform, setPlatform] = useState('all');

  const fetchContent = React.useCallback(async () => {
    try {
      setLoading(true);
      const params = {
        limit: 50,
        ...(platform !== 'all' && { platform }),
      };

      const response = await api.get('/content', { params });
      setContent(response.data);
    } catch (error) {
      toast.error('Failed to load content');
    } finally {
      setLoading(false);
    }
  }, [platform]);

  // Download Handler
  const handleDownload = async (item) => {
    try {
      const toastId = toast.loading('Preparing download...');
      const mediaUrl = item.content_url
        || (item.platform === 'facebook' ? `https://facebook.com/${item.source_id}` : null)
        || (item.platform === 'youtube' ? `https://youtube.com/watch?v=${item.source_id}` : null)
        || `https://twitter.com/${item.author_handle}/status/${item.source_id}`;
      
      const response = await api.post('/media/download', { media_url: mediaUrl, content_id: item.id });
      
      if (response.data && response.data.download_url) {
        const fileUrl = response.data.download_url;
        
        const link = document.createElement('a');
        link.href = fileUrl;
        link.setAttribute('download', '');
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        toast.success('Download started', { id: toastId });
      } else {
        toast.error('Download preparation failed', { id: toastId });
      }
    } catch (error) {
      console.error('Download error:', error);
      toast.error(error.response?.data?.error || 'Failed to download media');
    }
  };

  // Add to Sources Handler
  const handleAddSource = async (item) => {
    try {
      await api.post('/sources', {
        platform: item.platform,
        identifier: item.author_handle || item.author,
        display_name: item.author,
        category: 'monitored_feed_profile',
        priority: 'medium'
      });
      toast.success(`Profile @${item.author_handle || item.author} added to sources`);
    } catch (err) {
      toast.error(err?.response?.data?.message || 'Failed to add source');
      throw err;
    }
  };

  useEffect(() => {
    fetchContent();
  }, [fetchContent]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <div className="animate-spin rounded-full h-10 w-10 lg:h-12 lg:w-12 border-b-2 border-primary"></div>
      </div>
    );
  }

  return (
    <div className="space-y-4 lg:space-y-6" data-testid="content-feed-page">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl lg:text-3xl font-heading font-bold tracking-tight">Content Feed</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">Live monitored content from all sources</p>
        </div>
        <Button onClick={fetchContent} variant="outline" size="sm" className="gap-2">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap gap-3 p-4 bg-muted/50 rounded-lg border">
        <select
          className="h-9 w-[180px] rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
        >
          <option value="all">All Platforms</option>
          <option value="youtube">YouTube</option>
          <option value="x">X (Twitter)</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
        </select>
      </div>

      {/* Content List */}
      {content.length === 0 ? (
        <Card className="p-8 lg:p-12 text-center" data-testid="no-content">
          <p className="text-muted-foreground text-sm lg:text-base">No content found</p>
        </Card>
      ) : (
        <div className="space-y-3 lg:space-y-4">
          {content.map((item, index) => (
            <ContentCard 
              key={item.id || item._id} 
              item={item} 
              index={index} 
              onDownload={handleDownload}
              onAddSource={handleAddSource}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ContentFeed;
