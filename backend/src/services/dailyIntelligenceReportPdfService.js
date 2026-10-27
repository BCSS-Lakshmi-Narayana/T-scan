const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

const COLORS = {
    primary: '#1e40af',
    secondary: '#64748b',
    danger: '#dc2626',
    warning: '#f59e0b',
    success: '#16a34a',
    dark: '#1e293b',
    light: '#f1f5f9',
    white: '#ffffff'
};

const addHeader = (doc, title, dateKey) => {
    doc.fontSize(20)
        .fillColor(COLORS.primary)
        .font('Helvetica-Bold')
        .text('DAILY INTELLIGENCE REPORT', 50, 50, { align: 'center' });
    
    doc.fontSize(12)
        .fillColor(COLORS.secondary)
        .font('Helvetica')
        .text(`Report Date: ${dateKey}`, 50, 80, { align: 'center' });
    
    doc.fontSize(10)
        .text(`Generated: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`, 50, 100, { align: 'center' });
    
    doc.moveTo(50, 120)
        .lineTo(doc.page.width - 50, 120)
        .strokeColor(COLORS.primary)
        .lineWidth(2)
        .stroke();
};

const addFooter = (doc, pageNumber, totalPages) => {
    const footerY = doc.page.height - 50;
    
    doc.fontSize(8)
        .fillColor(COLORS.secondary)
        .font('Helvetica')
        .text(
            `CONFIDENTIAL - For Official Use Only | Page ${pageNumber} of ${totalPages}`,
            50,
            footerY,
            { align: 'center', width: doc.page.width - 100 }
        );
};

const addSection = (doc, title, yPosition) => {
    if (yPosition > doc.page.height - 150) {
        doc.addPage();
        yPosition = 50;
    }
    
    doc.fontSize(14)
        .fillColor(COLORS.primary)
        .font('Helvetica-Bold')
        .text(title, 50, yPosition);
    
    doc.moveTo(50, yPosition + 20)
        .lineTo(doc.page.width - 50, yPosition + 20)
        .strokeColor(COLORS.primary)
        .lineWidth(1)
        .stroke();
    
    return yPosition + 30;
};

const addKeyValuePair = (doc, key, value, yPosition, options = {}) => {
    const { color = COLORS.dark, bold = false } = options;
    
    if (yPosition > doc.page.height - 100) {
        doc.addPage();
        yPosition = 50;
    }
    
    doc.fontSize(10)
        .fillColor(COLORS.secondary)
        .font('Helvetica-Bold')
        .text(`${key}:`, 70, yPosition, { continued: true, width: 150 });
    
    doc.fillColor(color)
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .text(` ${value}`, { width: 400 });
    
    return yPosition + 20;
};

const addTable = (doc, headers, rows, yPosition) => {
    if (yPosition > doc.page.height - 200) {
        doc.addPage();
        yPosition = 50;
    }
    
    const tableTop = yPosition;
    const columnWidth = (doc.page.width - 100) / headers.length;
    let currentY = tableTop;
    
    doc.fontSize(9)
        .fillColor(COLORS.white)
        .font('Helvetica-Bold');
    
    doc.rect(50, currentY, doc.page.width - 100, 25)
        .fillAndStroke(COLORS.primary, COLORS.primary);
    
    headers.forEach((header, i) => {
        doc.text(header, 55 + (i * columnWidth), currentY + 8, {
            width: columnWidth - 10,
            align: 'left'
        });
    });
    
    currentY += 25;
    
    doc.fillColor(COLORS.dark)
        .font('Helvetica');
    
    rows.forEach((row, rowIndex) => {
        if (currentY > doc.page.height - 100) {
            doc.addPage();
            currentY = 50;
        }
        
        const bgColor = rowIndex % 2 === 0 ? COLORS.white : COLORS.light;
        doc.rect(50, currentY, doc.page.width - 100, 20)
            .fillAndStroke(bgColor, COLORS.secondary);
        
        row.forEach((cell, i) => {
            doc.fillColor(COLORS.dark)
                .text(String(cell), 55 + (i * columnWidth), currentY + 5, {
                    width: columnWidth - 10,
                    align: 'left'
                });
        });
        
        currentY += 20;
    });
    
    return currentY + 20;
};

const addBulletList = (doc, items, yPosition) => {
    items.forEach(item => {
        if (yPosition > doc.page.height - 100) {
            doc.addPage();
            yPosition = 50;
        }
        
        doc.fontSize(10)
            .fillColor(COLORS.dark)
            .font('Helvetica')
            .text('•', 70, yPosition, { continued: true })
            .text(` ${item}`, { width: 450 });
        
        yPosition += 25;
    });
    
    return yPosition;
};

const generateDailyIntelligenceReportPdf = async (reportData) => {
    return new Promise((resolve, reject) => {
        try {
            const doc = new PDFDocument({
                size: 'A4',
                margins: { top: 50, bottom: 50, left: 50, right: 50 },
                info: {
                    Title: `Daily Intelligence Report - ${reportData.date_key}`,
                    Author: 'BluraSaga Intelligence System',
                    Subject: 'Daily Intelligence Report',
                    Keywords: 'intelligence, report, daily, security'
                }
            });

            const chunks = [];
            doc.on('data', chunk => chunks.push(chunk));
            doc.on('end', () => resolve(Buffer.concat(chunks)));
            doc.on('error', reject);

            addHeader(doc, 'Daily Intelligence Report', reportData.date_key);

            let y = 140;

            y = addSection(doc, '1. EXECUTIVE SUMMARY', y);
            doc.fontSize(10)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.executive_summary, 70, y, { width: 480 });
            y += 150;

            y = addSection(doc, '2. DIAL 100 CALLS', y);
            y = addKeyValuePair(doc, 'Total Calls Received', reportData.dial100_calls.total_received, y, { bold: true });
            y = addKeyValuePair(doc, 'Critical Incidents', reportData.dial100_calls.critical_incidents, y, { 
                color: reportData.dial100_calls.critical_incidents > 10 ? COLORS.danger : COLORS.dark 
            });
            y = addKeyValuePair(doc, 'Average Response Time', `${reportData.dial100_calls.response_time_avg} minutes`, y);
            
            if (reportData.dial100_calls.by_category.length > 0) {
                y += 10;
                doc.fontSize(11)
                    .fillColor(COLORS.secondary)
                    .font('Helvetica-Bold')
                    .text('Top Categories:', 70, y);
                y += 20;
                
                const categoryRows = reportData.dial100_calls.by_category.slice(0, 10).map((c, i) => [
                    i + 1,
                    c.category,
                    c.count
                ]);
                y = addTable(doc, ['#', 'Category', 'Count'], categoryRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '3. GRIEVANCES', y);
            y = addKeyValuePair(doc, 'Total Generated', reportData.grievances.total_generated, y, { bold: true });
            y = addKeyValuePair(doc, 'Criticism', reportData.grievances.by_type.criticism, y);
            y = addKeyValuePair(doc, 'Suggestions', reportData.grievances.by_type.suggestion, y);
            y = addKeyValuePair(doc, 'Grievances', reportData.grievances.by_type.grievance, y);
            
            if (reportData.grievances.top_tagged_accounts.length > 0) {
                y += 10;
                doc.fontSize(11)
                    .fillColor(COLORS.secondary)
                    .font('Helvetica-Bold')
                    .text('Top Tagged Accounts:', 70, y);
                y += 20;
                
                const accountRows = reportData.grievances.top_tagged_accounts.slice(0, 10).map((a, i) => [
                    i + 1,
                    a.account,
                    a.count
                ]);
                y = addTable(doc, ['#', 'Account', 'Count'], accountRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '4. EVENTS', y);
            y = addKeyValuePair(doc, 'Total Fetched', reportData.events.total_fetched, y, { bold: true });
            y = addKeyValuePair(doc, 'Relevant Events', reportData.events.relevant_count, y, { 
                color: COLORS.success 
            });
            y = addKeyValuePair(doc, 'Relevance Rate', 
                `${reportData.events.total_fetched > 0 ? Math.round((reportData.events.relevant_count / reportData.events.total_fetched) * 100) : 0}%`, 
                y
            );
            
            if (reportData.events.top_events.length > 0) {
                y += 10;
                doc.fontSize(11)
                    .fillColor(COLORS.secondary)
                    .font('Helvetica-Bold')
                    .text('Top Events:', 70, y);
                y += 20;
                
                const eventRows = reportData.events.top_events.slice(0, 10).map((e, i) => [
                    i + 1,
                    e.event_name.substring(0, 30),
                    e.content_count,
                    e.platforms.join(', ')
                ]);
                y = addTable(doc, ['#', 'Event', 'Items', 'Platforms'], eventRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '5. ALERTS', y);
            y = addKeyValuePair(doc, 'Total Active Alerts', reportData.alerts.total_active, y, { bold: true });
            y = addKeyValuePair(doc, 'HIGH Priority', reportData.alerts.by_priority.high, y, { 
                color: COLORS.danger, bold: true 
            });
            y = addKeyValuePair(doc, 'MEDIUM Priority', reportData.alerts.by_priority.medium, y, { 
                color: COLORS.warning 
            });
            y = addKeyValuePair(doc, 'LOW Priority', reportData.alerts.by_priority.low, y);
            y = addKeyValuePair(doc, 'Escalated', reportData.alerts.escalated_count, y, { 
                color: COLORS.danger 
            });
            
            if (reportData.alerts.by_category.length > 0) {
                y += 10;
                doc.fontSize(11)
                    .fillColor(COLORS.secondary)
                    .font('Helvetica-Bold')
                    .text('Alert Categories:', 70, y);
                y += 20;
                
                const categoryRows = reportData.alerts.by_category.slice(0, 10).map((c, i) => [
                    i + 1,
                    c.category,
                    c.count
                ]);
                y = addTable(doc, ['#', 'Category', 'Count'], categoryRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '6. TOP 50 ALERTS', y);
            
            if (reportData.alerts.top_50_alerts.length > 0) {
                const alertRows = reportData.alerts.top_50_alerts.slice(0, 50).map((a, i) => [
                    i + 1,
                    a.title.substring(0, 40),
                    a.priority,
                    a.category.substring(0, 15),
                    a.platform
                ]);
                y = addTable(doc, ['#', 'Title', 'Priority', 'Category', 'Platform'], alertRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '7. TOP 5 CONCEPTS', y);
            
            if (reportData.top_concepts.length > 0) {
                const conceptRows = reportData.top_concepts.map((c, i) => [
                    i + 1,
                    c.concept,
                    c.count,
                    c.sentiment,
                    c.risk_level
                ]);
                y = addTable(doc, ['#', 'Concept', 'Count', 'Sentiment', 'Risk'], conceptRows, y);
            }

            y += 20;

            y = addSection(doc, '8. PROFILES MONITORING', y);
            y = addKeyValuePair(doc, 'Total Monitoring', reportData.profiles.total_monitoring, y, { bold: true });
            y = addKeyValuePair(doc, 'Deleted (Last 24h)', reportData.profiles.deleted_last_24h, y, { 
                color: reportData.profiles.deleted_last_24h > 0 ? COLORS.warning : COLORS.dark 
            });
            
            if (reportData.profiles.high_risk_profiles.length > 0) {
                y += 10;
                doc.fontSize(11)
                    .fillColor(COLORS.secondary)
                    .font('Helvetica-Bold')
                    .text('High-Risk Profiles:', 70, y);
                y += 20;
                
                const profileRows = reportData.profiles.high_risk_profiles.slice(0, 10).map((p, i) => [
                    i + 1,
                    p.name.substring(0, 25),
                    p.platform,
                    p.handle.substring(0, 20),
                    p.alert_count
                ]);
                y = addTable(doc, ['#', 'Name', 'Platform', 'Handle', 'Alerts'], profileRows, y);
            }

            doc.addPage();
            y = 50;

            y = addSection(doc, '9. TOP 10 KEYWORDS', y);
            
            if (reportData.top_keywords.length > 0) {
                const keywordRows = reportData.top_keywords.map((k, i) => [
                    i + 1,
                    k.keyword,
                    k.count,
                    k.trend,
                    k.platforms.join(', ')
                ]);
                y = addTable(doc, ['#', 'Keyword', 'Count', 'Trend', 'Platforms'], keywordRows, y);
            }

            y += 20;

            y = addSection(doc, '10. SUMMARY STATISTICS', y);
            y = addKeyValuePair(doc, 'Total Content Processed', reportData.summary_statistics.total_content_processed, y, { bold: true });
            y = addKeyValuePair(doc, 'Threat Rate', `${reportData.summary_statistics.threat_rate_percentage}%`, y, { 
                color: reportData.summary_statistics.threat_rate_percentage > 30 ? COLORS.danger : COLORS.dark 
            });
            y = addKeyValuePair(doc, 'Viral Posts', reportData.summary_statistics.viral_posts_count, y);
            y = addKeyValuePair(doc, 'Positive Sentiment', reportData.summary_statistics.sentiment_breakdown.positive, y, { color: COLORS.success });
            y = addKeyValuePair(doc, 'Negative Sentiment', reportData.summary_statistics.sentiment_breakdown.negative, y, { color: COLORS.danger });
            y = addKeyValuePair(doc, 'Neutral Sentiment', reportData.summary_statistics.sentiment_breakdown.neutral, y);

            doc.addPage();
            y = 50;

            y = addSection(doc, '11. DETAILED ANALYSIS', y);
            
            doc.fontSize(11)
                .fillColor(COLORS.secondary)
                .font('Helvetica-Bold')
                .text('Dial 100 Analysis:', 70, y);
            y += 20;
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.dial100_analysis, 70, y, { width: 480 });
            y += 100;

            if (y > doc.page.height - 200) {
                doc.addPage();
                y = 50;
            }

            doc.fontSize(11)
                .fillColor(COLORS.secondary)
                .font('Helvetica-Bold')
                .text('Grievance Analysis:', 70, y);
            y += 20;
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.grievance_analysis, 70, y, { width: 480 });
            y += 100;

            doc.addPage();
            y = 50;

            doc.fontSize(11)
                .fillColor(COLORS.secondary)
                .font('Helvetica-Bold')
                .text('Events Analysis:', 70, y);
            y += 20;
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.events_analysis, 70, y, { width: 480 });
            y += 100;

            if (y > doc.page.height - 200) {
                doc.addPage();
                y = 50;
            }

            doc.fontSize(11)
                .fillColor(COLORS.secondary)
                .font('Helvetica-Bold')
                .text('Alerts Analysis:', 70, y);
            y += 20;
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.alerts_analysis, 70, y, { width: 480 });
            y += 100;

            doc.addPage();
            y = 50;

            y = addSection(doc, '12. THREAT INTELLIGENCE', y);
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.threat_intelligence, 70, y, { width: 480 });
            y += 120;

            if (y > doc.page.height - 200) {
                doc.addPage();
                y = 50;
            }

            y = addSection(doc, '13. RECOMMENDATIONS', y);
            doc.fontSize(9)
                .fillColor(COLORS.dark)
                .font('Helvetica')
                .text(reportData.detailed_sections.recommendations, 70, y, { width: 480 });

            doc.end();

        } catch (error) {
            reject(error);
        }
    });
};

module.exports = {
    generateDailyIntelligenceReportPdf
};
