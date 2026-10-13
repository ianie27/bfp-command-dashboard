// src/pages/Reports/Reports.tsx
import React, { useState, useEffect } from 'react';
import {
  Card,
  Row,
  Col,
  Button,
  Table,
  Badge,
  Container,
  Form,
  Pagination,
} from 'react-bootstrap';
import {
  FaChartBar,
  FaPrint,
  FaChartPie,
  FaDownload,
  FaCalendarAlt,
} from 'react-icons/fa';
import { subscribeToIncidents } from '../../services/incidentService';
import { subscribeToUnits } from '../../services/unitService';
import type { Incident, ResponseUnit } from '../../types';
import { useAuth } from '../../hooks/useAuth';
import toast from 'react-hot-toast';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Title,
  Tooltip,
  Legend,
  ArcElement,
} from 'chart.js';
import { Bar, Pie } from 'react-chartjs-2';
import { BFP_LOGOS } from './bfpLogos';

// ============================================================
// BFP STATION CONFIGURATION
// ============================================================
const BFP_STATION_CONFIG = {
  republic: 'Republic of the Philippines',
  department: 'Department of the Interior and Local Government',
  bureau: 'BUREAU OF FIRE PROTECTION',
  region: 'REGION 2',
  station: 'GONZAGA FIRE STATION',
  address: 'Smart, Gonzaga, Cagayan',
  phone: '09055094969',
  email: 'bfpgonzagafs@yahoo.com',
  fireMarshal: {
    name: 'SFO4 RICHARD S. RAGUINDIN',
    title: 'Acting Municipal Fire Marshal',
  },
  investigator: {
    name: 'FO2 CHRISTIAN D DALMACEDA',
    title: 'Fire Arson Investigator',
  },
  iiUnitChief: {
    name: 'SFO1 DEARSON L NATIVIDAD JR',
    title: 'Chief, Intelligence and Investigation Unit',
  },
};

type ReportType = 'SIR' | 'PIR' | 'FIR';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend, ArcElement);

// Helper to format source text properly
const formatSource = (src: string): string => {
  if (!src) return 'N/A';
  const lower = src.toLowerCase().trim();
  if (lower === 'citizen' || lower.includes('citizen')) return 'Citizen';
  if (lower === 'iot sensor' || lower.includes('iot')) return 'IoT_Sensor';
  // Fallback: capitalize first letter of each word
  return src.replace(/\b\w/g, l => l.toUpperCase());
};

const Reports: React.FC = () => {
  const { user, logActivity } = useAuth();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [units, setUnits] = useState<ResponseUnit[]>([]);
  const [generating, setGenerating] = useState<boolean>(false);

  // Filter & Pagination State
  const [selectedMonth, setSelectedMonth] = useState<number>(new Date().getMonth());
  const [selectedYear, setSelectedYear] = useState<number>(new Date().getFullYear());
  const [currentPage, setCurrentPage] = useState<number>(1);
  const itemsPerPage = 10;

  useEffect(() => {
    const unsubIncidents = subscribeToIncidents((data) => {
      setIncidents(data);
    });
    const unsubUnits = subscribeToUnits((data) => {
      setUnits(data);
    });

    return () => {
      unsubIncidents();
      unsubUnits();
    };
  }, []);

  // Filter Logic: Filter by specific Month and Year
  const filteredIncidents = incidents.filter(inc => {
    const incDate = new Date(inc.reported_at);
    return incDate.getMonth() === selectedMonth && incDate.getFullYear() === selectedYear;
  });

  // Pagination Logic
  const totalPages = Math.ceil(filteredIncidents.length / itemsPerPage);
  const indexOfLastItem = currentPage * itemsPerPage;
  const indexOfFirstItem = indexOfLastItem - itemsPerPage;
  const currentIncidents = filteredIncidents.slice(indexOfFirstItem, indexOfLastItem);

  // Reset page when filter changes
  useEffect(() => {
    setCurrentPage(1);
  }, [selectedMonth, selectedYear]);

  const stats = {
    totalIncidents: filteredIncidents.length,
    highThreat: filteredIncidents.filter(i => i.threat_level === 'RED').length,
    lowThreat: filteredIncidents.filter(i => i.threat_level === 'YELLOW').length,
    resolved: filteredIncidents.filter(i => i.status === 'Resolved').length,
    active: filteredIncidents.filter(i => !['Resolved', 'Cancelled'].includes(i.status)).length,
  };

  const chartData = {
    labels: ['High Threat', 'Low Threat', 'Resolved', 'Active'],
    datasets: [{
      label: 'Incidents',
      data: [stats.highThreat, stats.lowThreat, stats.resolved, stats.active],
      backgroundColor: ['#dc3545', '#ffc107', '#28a745', '#007bff'],
      borderRadius: 8,
    }],
  };

  const pieData = {
    labels: ['Resolved', 'Active'],
    datasets: [{
      data: [stats.resolved, stats.active],
      backgroundColor: ['#28a745', '#007bff'],
      borderRadius: 8,
    }],
  };

  // ============================================
  // COMMON LETTERHEAD
  // ============================================
  const getLetterhead = (): string => {
    const cfg = BFP_STATION_CONFIG;
    return `
      <table class="logo-row">
        <tr>
          <td>
            <img src="${BFP_LOGOS.bfpSeal}"
                 alt="BFP Official Seal"
                 width="105" height="105"
                 style="width:105px;height:105px;display:block;margin:0 auto;" />
          </td>
          <td>
            <img src="${BFP_LOGOS.bagongPilipinas}"
                 alt="Bagong Pilipinas"
                 width="135" height="105"
                 style="width:135px;height:105px;display:block;margin:0 auto;" />
          </td>
          <td>
            <img src="${BFP_LOGOS.gonzaga}"
                 alt="Gonzaga Fire Station"
                 width="105" height="105"
                 style="width:105px;height:105px;display:block;margin:0 auto;" />
          </td>
        </tr>
      </table>
      <div class="letterhead">
        <div class="republic">${cfg.republic}</div>
        <div class="department">${cfg.department}</div>
        <div class="bureau">${cfg.bureau}</div>
        <div class="region">${cfg.region}</div>
        <div class="station">${cfg.station}</div>
        <div class="address">${cfg.address}</div>
        <div class="contact">Phone Number: ${cfg.phone}</div>
        <div class="contact">Email: <a href="mailto:${cfg.email}">${cfg.email}</a></div>
      </div>
      <div class="divider"></div>
    `;
  };

  // ============================================
  // COMMON STYLES
  // ============================================
  const getCommonStyles = (): string => {
    return `
      @page { size: 8.5in 13in; margin: 0.8in 0.8in 0.8in 0.8in; }
      body { 
        font-family: 'Times New Roman', Times, serif; 
        font-size: 12pt; 
        line-height: 1.2; 
        color: #000;
        margin: 0;
        padding: 0;
      }
      
      /* Letterhead */
      table.logo-row {
        width: 100%;
        border-collapse: collapse;
        border: none;
        margin: 0 0 10px 0;
        table-layout: fixed;
      }
      table.logo-row td {
        border: none;
        padding: 0 6px;
        vertical-align: bottom;
        text-align: center;
        width: 33.33%;
      }
      table.logo-row img {
        display: block !important;
        margin: 0 auto !important;
        max-width: 100% !important;
      }
      .letterhead {
        text-align: center;
        font-family: 'Times New Roman', Times, serif;
        margin-bottom: 5px;
      }
      .letterhead .republic { font-size: 12pt; font-weight: normal; line-height: 1.15; }
      .letterhead .department { font-size: 12pt; font-weight: normal; line-height: 1.15; }
      .letterhead .bureau { font-size: 13pt; font-weight: bold; line-height: 1.15; }
      .letterhead .region { font-size: 12pt; font-weight: bold; line-height: 1.15; }
      .letterhead .station { font-size: 13pt; font-weight: bold; line-height: 1.15; }
      .letterhead .address { font-size: 11pt; font-weight: normal; line-height: 1.15; }
      .letterhead .contact { font-size: 11pt; font-weight: normal; line-height: 1.15; }
      .letterhead .contact a { color: #0563C1; text-decoration: underline; }
      .divider { border-top: 2px solid #000; margin: 8px 0 15px 0; }
      
      /* Titles */
      .memo-title { 
        text-align: center; 
        font-size: 14pt; 
        font-weight: bold; 
        margin: 0 0 15px 0; 
        font-family: 'Times New Roman', Times, serif;
        letter-spacing: 1px;
      }
      
      /* Memo Tables */
      table.memo-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-family: 'Times New Roman', Times, serif;
        font-size: 12pt;
        margin-bottom: 15px;
      }
      table.memo-table td {
        border: 1px solid #000;
        padding: 8px 10px;
        vertical-align: middle;
        line-height: 1.3;
        word-wrap: break-word;
      }
      table.memo-table td.label {
        font-weight: bold;
        background: #F2F2F2;
        vertical-align: middle;
      }
      
      /* Section Headers */
      .section-header { 
        background: #D9D9D9; 
        font-weight: bold; 
        text-align: center; 
        font-size: 12pt; 
        padding: 8px 10px;
        border: 1px solid #000;
        margin-top: 15px;
        margin-bottom: 0;
        font-family: 'Times New Roman', Times, serif;
        letter-spacing: 0.5px;
      }
      
      /* Content Boxes */
      .details-box,
      .disposition-box,
      .facts-box,
      .discussion-box,
      .findings-box,
      .recommendation-box { 
        border: 1px solid #000;
        border-top: none;
        padding: 15px 18px;
        font-size: 12pt;
        font-family: 'Times New Roman', Times, serif;
        line-height: 1.4;
        margin-bottom: 15px;
        text-align: justify;
        min-height: 150px;
      }
      .disposition-box { min-height: 100px; }
      .placeholder { color: #666; font-style: italic; }
      
      /* SIGNATURE SECTION */
      .signature-block {
        margin-top: 60px;
        page-break-inside: avoid;
      }
      
      table.signature-table {
        width: 100%;
        border-collapse: collapse;
        border: none;
        table-layout: fixed;
      }
      table.signature-table td {
        border: none;
        vertical-align: top;
        text-align: center;
        width: 50%;
        padding: 0 20px;
        font-family: 'Times New Roman', Times, serif;
      }
      
      .sig-label {
        font-size: 12pt;
        font-weight: bold;
        text-transform: uppercase;
        margin-bottom: 55px;
        letter-spacing: 1px;
      }
      .sig-line {
        width: 90%;
        height: 0;
        margin: 0 auto;
        border-bottom: 1px solid #000;
      }
      .sig-name {
        font-weight: bold;
        font-size: 12pt;
        margin-top: 6px;
        text-transform: uppercase;
      }
      .sig-title {
        font-size: 11pt;
        margin-top: 3px;
        font-style: italic;
      }
      
      /* Footer */
      .footer-note { 
        font-size: 10pt; 
        font-style: italic; 
        margin-top: 50px; 
        text-align: center; 
        color: #444;
        font-family: 'Times New Roman', Times, serif;
        border-top: 1px solid #ccc;
        padding-top: 10px;
      }
      
      /* Sub-document (FIR specific) */
      .sub-doc-header {
        text-align: center;
        font-weight: bold;
        font-size: 13pt;
        margin: 20px 0 8px 0;
        font-family: 'Times New Roman', Times, serif;
      }
      .sub-doc-subheader {
        text-align: center;
        font-size: 12pt;
        margin-bottom: 15px;
        font-family: 'Times New Roman', Times, serif;
      }
      .sub-doc-table {
        width: 100%;
        border-collapse: collapse;
        table-layout: fixed;
        font-family: 'Times New Roman', Times, serif;
        font-size: 12pt;
        margin-bottom: 15px;
      }
      .sub-doc-table td {
        border: 1px solid #000;
        padding: 8px 10px;
        vertical-align: top;
        line-height: 1.3;
        word-wrap: break-word;
      }
      .sub-doc-table td.label {
        font-weight: bold;
        background: #F2F2F2;
        width: 30%;
      }
      
      @media print { 
        body { margin: 0; }
        .signature-block { page-break-inside: avoid; }
      }
    `;
  };

  // ============================================
  // MONTHLY REPORT GENERATOR
  // ============================================
  const generateMonthlyReportContent = (): string => {
    const cfg = BFP_STATION_CONFIG;
    const reportDate = new Date().toLocaleString('en-PH');
    const monthName = new Date(selectedYear, selectedMonth).toLocaleString('default', { month: 'long' });
    
    // Calculate stats for this specific month
    const monthIncidents = incidents.filter(inc => {
      const d = new Date(inc.reported_at);
      return d.getMonth() === selectedMonth && d.getFullYear() === selectedYear;
    });

    const total = monthIncidents.length;
    const high = monthIncidents.filter(i => i.threat_level === 'RED').length;
    const low = monthIncidents.filter(i => i.threat_level === 'YELLOW').length;
    const resolved = monthIncidents.filter(i => i.status === 'Resolved').length;
    const active = monthIncidents.filter(i => !['Resolved', 'Cancelled'].includes(i.status)).length;

    const rows = monthIncidents.map(inc => `
      <tr>
        <td>${inc.incident_id}</td>
        <td>${new Date(inc.reported_at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${inc.location_address || `${inc.latitude.toFixed(4)}, ${inc.longitude.toFixed(4)}`}</td>
        <td>${inc.threat_level || 'N/A'}</td>
        <td>${inc.status}</td>
      </tr>
    `).join('');

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' 
            xmlns:w='urn:schemas-microsoft-com:office:word' 
            xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="UTF-8">
        <title>BFP Monthly Report - ${monthName} ${selectedYear}</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>${getCommonStyles()}</style>
      </head>
      <body>
        ${getLetterhead()}

        <div class="memo-title">MONTHLY INCIDENT REPORT</div>

        <table class="memo-table">
          <colgroup>
            <col style="width: 30%;" />
            <col style="width: 70%;" />
          </colgroup>
          <tr>
            <td class="label">FOR:</td>
            <td>${cfg.fireMarshal.name}<br><i>${cfg.fireMarshal.title}</i></td>
          </tr>
          <tr>
            <td class="label">SUBJECT:</td>
            <td><b>Monthly Incident Report for ${monthName} ${selectedYear}</b></td>
          </tr>
          <tr>
            <td class="label">DATE:</td>
            <td>${reportDate}</td>
          </tr>
        </table>

        <div class="section-header">SUMMARY OF INCIDENTS</div>
        <div class="details-box" style="min-height: auto;">
          <p><b>Total Incidents:</b> ${total}</p>
          <p><b>High Threat (RED):</b> ${high}</p>
          <p><b>Low Threat (YELLOW):</b> ${low}</p>
          <p><b>Resolved:</b> ${resolved}</p>
          <p><b>Active:</b> ${active}</p>
        </div>

        <div class="section-header">INCIDENT DETAILS</div>
        <table class="sub-doc-table" style="font-size: 10pt;">
          <thead>
            <tr>
              <th style="width: 15%; text-align: center; background: #F2F2F2;">Incident ID</th>
              <th style="width: 20%; text-align: center; background: #F2F2F2;">Date/Time</th>
              <th style="width: 30%; text-align: center; background: #F2F2F2;">Location</th>
              <th style="width: 15%; text-align: center; background: #F2F2F2;">Threat</th>
              <th style="width: 20%; text-align: center; background: #F2F2F2;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="5" style="text-align:center;">No incidents recorded for this month.</td></tr>'}
          </tbody>
        </table>

        <div class="footer-note">
          Note: This report is confidential and intended solely for the use of the Bureau of Fire Protection.
          <br>Generated by EmberNet — ${reportDate}
        </div>
      </body>
      </html>
    `;
  };

  // ============================================
  // WEEKLY REPORT GENERATOR
  // ============================================
  const generateWeeklyReportContent = (): string => {
    const cfg = BFP_STATION_CONFIG;
    const reportDate = new Date().toLocaleString('en-PH');
    
    // Calculate start and end of current week (Sunday to Saturday)
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 1 = Monday, etc.
    const startOfWeek = new Date(now.setDate(now.getDate() - dayOfWeek));
    startOfWeek.setHours(0, 0, 0, 0);
    
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);

    const weekIncidents = incidents.filter(inc => {
      const d = new Date(inc.reported_at);
      return d >= startOfWeek && d <= endOfWeek;
    });

    const total = weekIncidents.length;
    const high = weekIncidents.filter(i => i.threat_level === 'RED').length;
    const low = weekIncidents.filter(i => i.threat_level === 'YELLOW').length;
    const resolved = weekIncidents.filter(i => i.status === 'Resolved').length;
    const active = weekIncidents.filter(i => !['Resolved', 'Cancelled'].includes(i.status)).length;

    const dateRangeStr = `${startOfWeek.toLocaleDateString('en-PH', { month: 'long', day: 'numeric' })} - ${endOfWeek.toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' })}`;

    const rows = weekIncidents.map(inc => `
      <tr>
        <td>${inc.incident_id}</td>
        <td>${new Date(inc.reported_at).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
        <td>${inc.location_address || `${inc.latitude.toFixed(4)}, ${inc.longitude.toFixed(4)}`}</td>
        <td>${inc.threat_level || 'N/A'}</td>
        <td>${inc.status}</td>
      </tr>
    `).join('');

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' 
            xmlns:w='urn:schemas-microsoft-com:office:word' 
            xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="UTF-8">
        <title>BFP Weekly Report</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>${getCommonStyles()}</style>
      </head>
      <body>
        ${getLetterhead()}

        <div class="memo-title">WEEKLY INCIDENT REPORT</div>

        <table class="memo-table">
          <colgroup>
            <col style="width: 30%;" />
            <col style="width: 70%;" />
          </colgroup>
          <tr>
            <td class="label">FOR:</td>
            <td>${cfg.fireMarshal.name}<br><i>${cfg.fireMarshal.title}</i></td>
          </tr>
          <tr>
            <td class="label">SUBJECT:</td>
            <td><b>Weekly Incident Report (${dateRangeStr})</b></td>
          </tr>
          <tr>
            <td class="label">DATE:</td>
            <td>${reportDate}</td>
          </tr>
        </table>

        <div class="section-header">SUMMARY OF INCIDENTS</div>
        <div class="details-box" style="min-height: auto;">
          <p><b>Total Incidents:</b> ${total}</p>
          <p><b>High Threat (RED):</b> ${high}</p>
          <p><b>Low Threat (YELLOW):</b> ${low}</p>
          <p><b>Resolved:</b> ${resolved}</p>
          <p><b>Active:</b> ${active}</p>
        </div>

        <div class="section-header">INCIDENT DETAILS</div>
        <table class="sub-doc-table" style="font-size: 10pt;">
          <thead>
            <tr>
              <th style="width: 15%; text-align: center; background: #F2F2F2;">Incident ID</th>
              <th style="width: 20%; text-align: center; background: #F2F2F2;">Date/Time</th>
              <th style="width: 30%; text-align: center; background: #F2F2F2;">Location</th>
              <th style="width: 15%; text-align: center; background: #F2F2F2;">Threat</th>
              <th style="width: 20%; text-align: center; background: #F2F2F2;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${rows.length > 0 ? rows : '<tr><td colspan="5" style="text-align:center;">No incidents recorded for this week.</td></tr>'}
          </tbody>
        </table>

        <div class="footer-note">
          Note: This report is confidential and intended solely for the use of the Bureau of Fire Protection.
          <br>Generated by EmberNet — ${reportDate}
        </div>
      </body>
      </html>
    `;
  };

  // ============================================
  // SIR (Spot Investigation Report)
  // ============================================
  const generateSIRContent = (incident?: Incident): string => {
    const cfg = BFP_STATION_CONFIG;
    const reportDate = new Date().toLocaleString('en-PH');
    const targetIncident = incident || filteredIncidents[0];

    const incidentDate = targetIncident
      ? new Date(targetIncident.reported_at).toLocaleDateString('en-PH', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : '_______________________';

    const incidentTime = targetIncident
      ? new Date(targetIncident.reported_at).toLocaleTimeString('en-PH', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
      : '____________';

    const fireOutTime = (targetIncident && targetIncident.status === 'Resolved' && targetIncident.resolved_at)
      ? new Date(targetIncident.resolved_at).toLocaleTimeString('en-PH', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
      : '____________________';

    const locationAddress = targetIncident?.location_address
      || (targetIncident
        ? `${targetIncident.latitude.toFixed(5)}, ${targetIncident.longitude.toFixed(5)}`
        : '_______________________');

    const threatLevel = targetIncident?.threat_level || 'N/A';
    const incidentId = targetIncident?.incident_id || '_______________________';
    const description = targetIncident?.description || '';
    const source = formatSource(targetIncident?.source || '');

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' 
            xmlns:w='urn:schemas-microsoft-com:office:word' 
            xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="UTF-8">
        <title>BFP Spot Investigation Report</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>${getCommonStyles()}</style>
      </head>
      <body>
        ${getLetterhead()}

        <div class="memo-title">MEMORANDUM</div>

        <table class="memo-table">
          <colgroup>
            <col style="width: 22%;" />
            <col style="width: 78%;" />
          </colgroup>
          <tr>
            <td class="label">FOR:</td>
            <td>${cfg.fireMarshal.name}<br><i>${cfg.fireMarshal.title}</i></td>
          </tr>
          <tr>
            <td class="label">SUBJECT:</td>
            <td><b>Spot Investigation Report (SIR)</b></td>
          </tr>
          <tr>
            <td class="label">DATE:</td>
            <td>${incidentDate}</td>
          </tr>
        </table>

        <table class="memo-table">
          <colgroup>
            <col style="width: 24%;" />
            <col style="width: 26%;" />
            <col style="width: 22%;" />
            <col style="width: 28%;" />
          </colgroup>
          <tr>
            <td class="label">DTPO Involved:</td>
            <td>${cfg.investigator.name}</td>
            <td class="label">Alarm:</td>
            <td>${incidentTime}</td>
          </tr>
          <tr>
            <td class="label">Incident ID:</td>
            <td colspan="3"><b>${incidentId}</b></td>
          </tr>
          <tr>
            <td class="label">Name of Establishment:</td>
            <td colspan="3">_____________________________________________</td>
          </tr>
          <tr>
            <td class="label">Location:</td>
            <td colspan="3">${locationAddress}</td>
          </tr>
          <tr>
            <td class="label">Owner:</td>
            <td colspan="3">_____________________________________________</td>
          </tr>
          <tr>
            <td class="label">Occupant:</td>
            <td colspan="3">_____________________________________________</td>
          </tr>
          <tr>
            <td class="label">Casualty:</td>
            <td colspan="3">
              [&nbsp;&nbsp;] Fatality &nbsp;&nbsp;&nbsp;
              [&nbsp;&nbsp;] Injured &nbsp;&nbsp;&nbsp;
              [&nbsp;&nbsp;] None
            </td>
          </tr>
          <tr>
            <td class="label">Estimated Damage:</td>
            <td>PHP ____________________</td>
            <td class="label">Threat Level:</td>
            <td>${threatLevel}</td>
          </tr>
          <tr>
            <td class="label">Time Fire Started:</td>
            <td>${incidentTime}</td>
            <td class="label">Time of Fire Out:</td>
            <td>${fireOutTime}</td>
          </tr>
          <tr>
            <td class="label">Source:</td>
            <td colspan="3">${source}</td>
          </tr>
        </table>

        <div class="section-header">DETAILS OF INVESTIGATION</div>
        <div class="details-box">
          ${description
            ? description
            : `<span class="placeholder">(State the facts of the case, including date, time, place, circumstances, and other relevant information.)</span>`}
        </div>

        <div class="section-header">DISPOSITION</div>
        <div class="disposition-box">
          The undersigned investigator is still in the process of ascertaining the cause of fire.
          Progress Investigation Report to follow.
        </div>

        <!-- SIGNATURE SECTION FOR SIR -->
        <div class="signature-block">
          <table class="signature-table">
            <tr>
              <td>
                <div class="sig-label">NOTED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.iiUnitChief.name}</div>
                <div class="sig-title">${cfg.iiUnitChief.title}</div>
              </td>
              <td>
                <div class="sig-label">APPROVED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.fireMarshal.name}</div>
                <div class="sig-title">${cfg.fireMarshal.title}</div>
              </td>
            </tr>
          </table>
        </div>

        <div class="footer-note">
          Note: This report is confidential and intended solely for the use of the Bureau of Fire Protection.
          <br>Generated by EmberNet — ${reportDate}
        </div>
      </body>
      </html>
    `;
  };

  // ============================================
  // PIR (Progress Investigation Report)
  // ============================================
  const generatePIRContent = (incident?: Incident): string => {
    const cfg = BFP_STATION_CONFIG;
    const reportDate = new Date().toLocaleString('en-PH');
    const targetIncident = incident || filteredIncidents[0];

    const incidentDate = targetIncident
      ? new Date(targetIncident.reported_at).toLocaleDateString('en-PH', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : '_______________________';

    const description = targetIncident?.description || '';

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' 
            xmlns:w='urn:schemas-microsoft-com:office:word' 
            xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="UTF-8">
        <title>BFP Progress Investigation Report</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>${getCommonStyles()}</style>
      </head>
      <body>
        ${getLetterhead()}

        <div class="memo-title">MEMORANDUM</div>

        <table class="memo-table">
          <colgroup>
            <col style="width: 22%;" />
            <col style="width: 78%;" />
          </colgroup>
          <tr>
            <td class="label">FOR:</td>
            <td>${cfg.fireMarshal.name}<br><i>${cfg.fireMarshal.title}</i></td>
          </tr>
          <tr>
            <td class="label">SUBJECT:</td>
            <td><b>Progress Investigation Report</b></td>
          </tr>
          <tr>
            <td class="label">DATE:</td>
            <td>${incidentDate}</td>
          </tr>
        </table>

        <div class="section-header">AUTHORITY:</div>
        <div class="details-box" style="min-height: auto;">
          <p>a. Section 50, Rule VIII of the Implementing Rules and Regulations of RA 6975;</p>
          <p>b. SOP No. 2023 - 001: Standard Operating Procedure on Fire Investigation in the Bureau of Fire Protection; and</p>
          <p>c. Mission Order Nr. (2025-06-001) dated (06 June 2025)</p>
        </div>

        <div class="section-header">MATTERS INVESTIGATED:</div>
        <div class="details-box" style="min-height: auto;">
          <p>a. The origin and cause of the fire incident.</p>
          <p>b. The responsible person/s if there is/are any.</p>
          <p>c. Other matters relative to the occurrence of the fire incident.</p>
        </div>

        <div class="section-header">FACTS OF THE CASE:</div>
        <div class="facts-box">
          ${description
            ? description
            : `<span class="placeholder">(State the facts of the case, including date, time, place, circumstances, and other relevant information.)</span>`}
        </div>

        <div class="section-header">DISPOSITION:</div>
        <div class="disposition-box">
          The undersigned investigator is still in the process of ascertaining the cause of the fire and is also still in the process of ascertaining the total damage to the affected property.
          <br><br>
          A Final Investigation Report will follow.
        </div>

        <!-- SIGNATURE SECTION FOR PIR -->
        <div class="signature-block">
          <table class="signature-table">
            <tr>
              <td>
                <div class="sig-label">PREPARED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.investigator.name}</div>
                <div class="sig-title">${cfg.investigator.title}</div>
              </td>
              <td>
                <div class="sig-label">NOTED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.iiUnitChief.name}</div>
                <div class="sig-title">${cfg.iiUnitChief.title}</div>
              </td>
            </tr>
          </table>
          
          <div style="text-align: center; margin-top: 50px;">
            <div class="sig-label">APPROVED BY:</div>
            <div class="sig-line" style="width: 45%;"></div>
            <div class="sig-name">${cfg.fireMarshal.name}</div>
            <div class="sig-title">${cfg.fireMarshal.title}</div>
          </div>
        </div>

        <div class="footer-note">
          Note: This report is confidential and intended solely for the use of the Bureau of Fire Protection.
          <br>Generated by EmberNet — ${reportDate}
        </div>
      </body>
      </html>
    `;
  };

  // ============================================
  // FIR (Final Investigation Report)
  // ============================================
  const generateFIRContent = (incident?: Incident): string => {
    const cfg = BFP_STATION_CONFIG;
    const reportDate = new Date().toLocaleString('en-PH');
    const targetIncident = incident || filteredIncidents[0];

    const incidentDate = targetIncident
      ? new Date(targetIncident.reported_at).toLocaleDateString('en-PH', {
          year: 'numeric', month: 'long', day: 'numeric',
        })
      : '_______________________';

    const incidentTime = targetIncident
      ? new Date(targetIncident.reported_at).toLocaleTimeString('en-PH', {
          hour: '2-digit', minute: '2-digit', hour12: true,
        })
      : '____________';

    const locationAddress = targetIncident?.location_address
      || (targetIncident
        ? `${targetIncident.latitude.toFixed(5)}, ${targetIncident.longitude.toFixed(5)}`
        : '_______________________');

    const description = targetIncident?.description || '';

    return `
      <html xmlns:o='urn:schemas-microsoft-com:office:office' 
            xmlns:w='urn:schemas-microsoft-com:office:word' 
            xmlns='http://www.w3.org/TR/REC-html40'>
      <head>
        <meta charset="UTF-8">
        <title>BFP Final Investigation Report</title>
        <!--[if gte mso 9]>
        <xml>
          <w:WordDocument>
            <w:View>Print</w:View>
            <w:Zoom>100</w:Zoom>
          </w:WordDocument>
        </xml>
        <![endif]-->
        <style>${getCommonStyles()}</style>
      </head>
      <body>
        ${getLetterhead()}

        <div class="memo-title">MEMORANDUM</div>

        <table class="memo-table">
          <colgroup>
            <col style="width: 22%;" />
            <col style="width: 78%;" />
          </colgroup>
          <tr>
            <td class="label">FOR:</td>
            <td>${cfg.fireMarshal.name}<br><i>${cfg.fireMarshal.title}</i></td>
          </tr>
          <tr>
            <td class="label">SUBJECT:</td>
            <td><b>Final Investigation Report</b></td>
          </tr>
          <tr>
            <td class="label">DATE:</td>
            <td>${incidentDate}</td>
          </tr>
        </table>

        <div class="sub-doc-header">FINAL INVESTIGATION REPORT (F.I.R)</div>
        <div class="sub-doc-subheader">Intelligence and Investigation Unit<br>Gonzaga Fire Station, Gonzaga, Cagayan</div>

        <table class="sub-doc-table">
          <tr>
            <td class="label">01. PLACE OF FIRE:</td>
            <td>${locationAddress}</td>
          </tr>
          <tr>
            <td class="label">02. TIME AND DATE OF ALARM:</td>
            <td>${incidentTime} — ${incidentDate}</td>
          </tr>
          <tr>
            <td class="label">03. ESTABLISHMENT BURNED:</td>
            <td>_____________________________________________</td>
          </tr>
          <tr>
            <td class="label">04. FIRE VICTIM/S:</td>
            <td>[&nbsp;&nbsp;] Fatality &nbsp;&nbsp;&nbsp; [&nbsp;&nbsp;] Injured &nbsp;&nbsp;&nbsp; [&nbsp;&nbsp;] None</td>
          </tr>
          <tr>
            <td class="label">05. DAMAGE TO PROPERTY:</td>
            <td>PHP ____________________</td>
          </tr>
          <tr>
            <td class="label">06. ORIGIN OF FIRE:</td>
            <td>_______________________</td>
          </tr>
          <tr>
            <td class="label">07. CAUSE OF FIRE:</td>
            <td>_______________________</td>
          </tr>
        </table>

        <div class="section-header">08. SUBSTANTIATING DOCUMENTS:</div>
        <div class="details-box" style="min-height: auto;">
          <p>A. Spot Investigation Report</p>
          <p>B. Progress Investigation Report</p>
          <p>C. Affidavit of loss (itemized and duly notarized)</p>
          <p>D. Affidavit of Jerry Castro y Delos Santos with ID picture</p>
          <p>E. Photographs of the fire scene</p>
          <p>F. Rough Sketch</p>
          <p>G. Mission Order GFS-2025-06-002</p>
        </div>

        <div class="section-header">FACTS OF THE CASE:</div>
        <div class="facts-box">
          ${description
            ? description
            : `<span class="placeholder">(State the facts of the case, including date, time, place, circumstances, and other relevant information.)</span>`}
        </div>

        <div class="section-header">DISCUSSION:</div>
        <div class="discussion-box">
          <span class="placeholder">(Discuss the investigation conducted, evidence gathered, and analysis made.)</span>
        </div>

        <div class="section-header">FINDINGS:</div>
        <div class="findings-box">
          <span class="placeholder">(State the findings of the investigation, including the origin and cause of fire, responsible persons, and other relevant findings.)</span>
        </div>

        <div class="section-header">RECOMMENDATION:</div>
        <div class="recommendation-box">
          <span class="placeholder">(State the recommendations, including filing of appropriate charges, if any.)</span>
        </div>

        <p style="text-align: center; font-size: 12pt; margin: 20px 0;">
          SIGNED this ${new Date().getDate()}<sup>${getOrdinalSuffix(new Date().getDate())}</sup> day of ${new Date().toLocaleDateString('en-PH', { month: 'long' })} ${new Date().getFullYear()} at the Gonzaga Fire Station, Brgy. Smart, Gonzaga, Cagayan, Philippines.
        </p>

        <!-- SIGNATURE SECTION FOR FIR -->
        <div class="signature-block">
          <table class="signature-table">
            <tr>
              <td>
                <div class="sig-label">PREPARED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.investigator.name}</div>
                <div class="sig-title">${cfg.investigator.title}</div>
              </td>
              <td>
                <div class="sig-label">NOTED BY:</div>
                <div class="sig-line"></div>
                <div class="sig-name">${cfg.iiUnitChief.name}</div>
                <div class="sig-title">${cfg.iiUnitChief.title}</div>
              </td>
            </tr>
          </table>
          
          <div style="text-align: center; margin-top: 50px;">
            <div class="sig-label">APPROVED BY:</div>
            <div class="sig-line" style="width: 45%;"></div>
            <div class="sig-name">${cfg.fireMarshal.name}</div>
            <div class="sig-title">${cfg.fireMarshal.title}</div>
          </div>
        </div>

        <div class="footer-note">
          Note: This report is confidential and intended solely for the use of the Bureau of Fire Protection.
          <br>Generated by EmberNet — ${reportDate}
        </div>
      </body>
      </html>
    `;
  };

  const getOrdinalSuffix = (n: number): string => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
  };

  // ============================================
  // GENERATE REPORT CONTENT BASED ON TYPE
  // ============================================
  const generateReportContent = (type: ReportType, incident?: Incident): string => {
    switch (type) {
      case 'SIR':
        return generateSIRContent(incident);
      case 'PIR':
        return generatePIRContent(incident);
      case 'FIR':
        return generateFIRContent(incident);
      default:
        return generateSIRContent(incident);
    }
  };

  // ============================================
  // EXPORT SINGLE INCIDENT AS BFP REPORT
  // ============================================
  const exportIncidentReport = (incident: Incident, type: ReportType): void => {
    try {
      const content = generateReportContent(type, incident);
      const blob = new Blob([content], { type: 'application/msword;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `BFP_${type}_${incident.incident_id}.doc`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 1000);

      toast.success(`BFP ${type} for ${incident.incident_id} downloaded`);
      logActivity(`generate_bfp_${type.toLowerCase()}`, 'incident', incident.incident_id).catch(() => {});
    } catch (error) {
      console.error(`BFP ${type} export error:`, error);
      toast.error(`Failed to export BFP ${type}`);
    }
  };

  // ============================================
  // PRINT SINGLE REPORT
  // ============================================
  const handlePrintIncident = (incident: Incident, type: ReportType): void => {
    const content = generateReportContent(type, incident);
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head><title>BFP ${type} - ${incident.incident_id}</title></head>
          <body>${content}</body>
        </html>
      `);
      printWindow.document.close();
      setTimeout(() => printWindow.print(), 500);
    }
  };

  // ============================================
  // PRINT MONTHLY REPORT
  // ============================================
  const handlePrintMonthlyReport = (): void => {
    const content = generateMonthlyReportContent();
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head><title>BFP Monthly Report - ${new Date(selectedYear, selectedMonth).toLocaleString('default', { month: 'long' })} ${selectedYear}</title></head>
          <body>${content}</body>
        </html>
      `);
      printWindow.document.close();
      setTimeout(() => printWindow.print(), 500);
    }
  };

  // ============================================
  // PRINT WEEKLY REPORT
  // ============================================
  const handlePrintWeeklyReport = (): void => {
    const content = generateWeeklyReportContent();
    const printWindow = window.open('', '_blank', 'width=900,height=700');
    if (printWindow) {
      printWindow.document.write(`
        <!DOCTYPE html>
        <html>
          <head><title>BFP Weekly Report</title></head>
          <body>${content}</body>
        </html>
      `);
      printWindow.document.close();
      setTimeout(() => printWindow.print(), 500);
    }
  };

  return (
    <div className="reports-page" style={{ backgroundColor: '#0f0f1a', minHeight: '100vh' }}>
      <Container fluid className="p-4">
        {/* Page Header */}
        <div className="mb-4 pb-2 border-bottom border-secondary">
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h2 className="text-white mb-1">
                <FaChartBar className="me-2 text-danger" />
                Reports & Analytics
              </h2>
              <p className="text-light-50 mb-0">Generate and export comprehensive incident reports</p>
            </div>
          </div>
        </div>

        {/* NEW FILTER CARD CONTAINER */}
        <Card className="mb-4" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
          <Card.Header style={{ backgroundColor: '#0f0f1a', borderBottom: '1px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
            <div className="d-flex align-items-center">
              <FaCalendarAlt className="me-2 text-danger" />
              <h6 className="mb-0 text-white">Filter & Generate Reports</h6>
            </div>
          </Card.Header>
          <Card.Body>
            <Row className="g-3 align-items-end">
              <Col md={3}>
                <Form.Label className="text-light small">Month</Form.Label>
                <Form.Select 
                  size="sm" 
                  style={{ backgroundColor: '#0f0f1a', color: 'white', borderColor: '#2a2a4e' }}
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(parseInt(e.target.value))}
                >
                  {Array.from({ length: 12 }, (_, i) => (
                    <option key={i} value={i}>
                      {new Date(0, i).toLocaleString('default', { month: 'long' })}
                    </option>
                  ))}
                </Form.Select>
              </Col>
              <Col md={2}>
                <Form.Label className="text-light small">Year</Form.Label>
                <Form.Select 
                  size="sm" 
                  style={{ backgroundColor: '#0f0f1a', color: 'white', borderColor: '#2a2a4e' }}
                  value={selectedYear}
                  onChange={(e) => setSelectedYear(parseInt(e.target.value))}
                >
                  {Array.from({ length: 5 }, (_, i) => {
                    const year = new Date().getFullYear() - i;
                    return <option key={year} value={year}>{year}</option>;
                  })}
                </Form.Select>
              </Col>
              <Col md={7} className="d-flex gap-2 justify-content-md-end">
                <Button
                  variant="outline-danger"
                  size="sm"
                  onClick={handlePrintMonthlyReport}
                  disabled={filteredIncidents.length === 0}
                >
                  <FaPrint className="me-2" /> Print Monthly Report
                </Button>
                <Button
                  variant="outline-warning"
                  size="sm"
                  onClick={handlePrintWeeklyReport}
                >
                  <FaPrint className="me-2" /> Print Weekly Report
                </Button>
              </Col>
            </Row>
          </Card.Body>
        </Card>

        {/* Stats Overview */}
        <div className="mb-4">
          <h6 className="text-white mb-3">
            <FaChartBar className="me-2 text-danger" />
            Key Performance Indicators
          </h6>
          <Row className="g-3">
            <Col lg={3} md={3} sm={6} xs={6}>
              <Card className="text-center h-100" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <h2 className="text-danger mb-1" style={{ fontWeight: 'bold', fontSize: '2rem' }}>{stats.totalIncidents}</h2>
                  <small className="text-light">Total Incidents</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={3} md={3} sm={6} xs={6}>
              <Card className="text-center h-100" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <h2 className="text-danger mb-1" style={{ fontWeight: 'bold', fontSize: '2rem' }}>{stats.highThreat}</h2>
                  <small className="text-light">High Threat</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={3} md={3} sm={6} xs={6}>
              <Card className="text-center h-100" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <h2 className="text-warning mb-1" style={{ fontWeight: 'bold', fontSize: '2rem', color: '#ffc107' }}>{stats.lowThreat}</h2>
                  <small className="text-light">Low Threat</small>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={3} md={3} sm={6} xs={6}>
              <Card className="text-center h-100" style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Body>
                  <h2 className="text-success mb-1" style={{ fontWeight: 'bold', fontSize: '2rem' }}>{stats.resolved}</h2>
                  <small className="text-light">Resolved</small>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </div>

        {/* Charts */}
        <div className="mb-4">
          <Row className="g-4">
            <Col lg={7}>
              <Card style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Header style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
                  <div className="d-flex align-items-center">
                    <FaChartBar className="me-2 text-danger" />
                    <h6 className="mb-0 text-white">Incident Distribution Analysis</h6>
                  </div>
                </Card.Header>
                <Card.Body>
                  <div style={{ height: '350px' }}>
                    <Bar
                      data={chartData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: false,
                        plugins: {
                          legend: { labels: { color: 'white', font: { size: 12 } } },
                          tooltip: { backgroundColor: '#1a1a2e', titleColor: 'white', bodyColor: '#adb5bd' },
                        },
                        scales: {
                          y: { ticks: { color: 'white' }, grid: { color: '#2a2a4e' } },
                          x: { ticks: { color: 'white' }, grid: { color: '#2a2a4e' } },
                        },
                      }}
                    />
                  </div>
                </Card.Body>
              </Card>
            </Col>
            <Col lg={5}>
              <Card style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
                <Card.Header style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}>
                  <div className="d-flex align-items-center">
                    <FaChartPie className="me-2 text-danger" />
                    <h6 className="mb-0 text-white">Status Breakdown</h6>
                  </div>
                </Card.Header>
                <Card.Body className="d-flex justify-content-center align-items-center">
                  <div style={{ width: '100%', maxWidth: '300px', height: '300px' }}>
                    <Pie
                      data={pieData}
                      options={{
                        responsive: true,
                        maintainAspectRatio: true,
                        plugins: {
                          legend: { position: 'bottom', labels: { color: 'white', font: { size: 12 } } },
                          tooltip: { backgroundColor: '#1a1a2e', titleColor: 'white', bodyColor: '#adb5bd' },
                        },
                      }}
                    />
                  </div>
                </Card.Body>
              </Card>
            </Col>
          </Row>
        </div>

        {/* Incident Details Table */}
        <Card style={{ backgroundColor: '#1a1a2e', border: '1px solid #2a2a4e', borderRadius: '12px' }}>
          <Card.Header
            className="d-flex justify-content-between align-items-center"
            style={{ backgroundColor: '#0f0f1a', borderBottom: '2px solid #2a2a4e', borderRadius: '12px 12px 0 0' }}
          >
            <div className="d-flex align-items-center">
              <FaDownload className="me-2 text-danger" />
              <h6 className="mb-0 text-white">Incident Details</h6>
            </div>
            <Badge bg="danger" className="px-3 py-2">
              {filteredIncidents.length} Records Found
            </Badge>
          </Card.Header>
          <div className="table-responsive">
            <Table hover className="mb-0" style={{ backgroundColor: 'white', color: '#212529' }}>
              <thead style={{ backgroundColor: '#f8f9fa', color: '#212529' }}>
                <tr>
                  <th style={{ fontWeight: 'bold' }}>Incident ID</th>
                  <th style={{ fontWeight: 'bold' }}>Date/Time</th>
                  <th style={{ fontWeight: 'bold' }}>Threat</th>
                  <th style={{ fontWeight: 'bold' }}>Status</th>
                  <th style={{ fontWeight: 'bold' }}>Location</th>
                  <th style={{ fontWeight: 'bold' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {currentIncidents.map((incident) => (
                  <tr key={incident.incident_id}>
                    <td><strong className="text-danger">{incident.incident_id}</strong></td>
                    <td>{new Date(incident.reported_at).toLocaleString()}</td>
                    <td>
                      <Badge bg={incident.threat_level === 'RED' ? 'danger' : 'warning'}>
                        {incident.threat_level || 'N/A'}
                      </Badge>
                    </td>
                    <td>
                      <Badge
                        bg={
                          incident.status === 'Resolved'
                            ? 'success'
                            : incident.status === 'Cancelled'
                              ? 'secondary'
                              : 'primary'
                        }
                      >
                        {incident.status}
                      </Badge>
                    </td>
                    <td>
                      <small>
                        {incident.location_address ||
                          `${incident.latitude.toFixed(4)}, ${incident.longitude.toFixed(4)}`}
                      </small>
                    </td>
                    <td>
                      <div className="d-flex gap-1 flex-wrap">
                        <Button
                          variant="outline-danger"
                          size="sm"
                          title="Export Spot Investigation Report"
                          onClick={() => exportIncidentReport(incident, 'SIR')}
                          style={{ fontSize: '11px', padding: '3px 8px' }}
                          disabled={generating}
                        >
                          SIR
                        </Button>
                        <Button
                          variant="outline-warning"
                          size="sm"
                          title="Export Progress Investigation Report"
                          onClick={() => exportIncidentReport(incident, 'PIR')}
                          style={{ fontSize: '11px', padding: '3px 8px' }}
                          disabled={generating}
                        >
                          PIR
                        </Button>
                        <Button
                          variant="outline-primary"
                          size="sm"
                          title="Export Final Investigation Report"
                          onClick={() => exportIncidentReport(incident, 'FIR')}
                          style={{ fontSize: '11px', padding: '3px 8px' }}
                          disabled={generating}
                        >
                          FIR
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filteredIncidents.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-5">
                      <div className="text-muted">
                        <FaChartBar className="mb-2" style={{ fontSize: '48px', opacity: 0.5 }} />
                        <p className="mb-0">No incidents found in the selected month</p>
                        <small>Try adjusting your filter criteria</small>
                      </div>
                    </td>
                  </tr>
                )}
              </tbody>
            </Table>
          </div>
          
          {/* Pagination Footer */}
          {filteredIncidents.length > 0 && (
            <Card.Footer style={{ backgroundColor: '#f8f9fa', borderTop: '1px solid #dee2e6' }}>
              <div className="d-flex justify-content-between align-items-center">
                <small className="text-muted">
                  Showing {indexOfFirstItem + 1} to {Math.min(indexOfLastItem, filteredIncidents.length)} of {filteredIncidents.length} incidents
                </small>
                <Pagination size="sm" className="mb-0">
                  <Pagination.Prev 
                    onClick={() => setCurrentPage(prev => Math.max(prev - 1, 1))} 
                    disabled={currentPage === 1} 
                  />
                  {[...Array(totalPages)].map((_, i) => (
                    <Pagination.Item
                      key={i + 1}
                      active={i + 1 === currentPage}
                      onClick={() => setCurrentPage(i + 1)}
                    >
                      {i + 1}
                    </Pagination.Item>
                  ))}
                  <Pagination.Next 
                    onClick={() => setCurrentPage(prev => Math.min(prev + 1, totalPages))} 
                    disabled={currentPage === totalPages} 
                  />
                </Pagination>
              </div>
            </Card.Footer>
          )}
        </Card>
      </Container>
    </div>
  );
};

export default Reports;