const express = require('express');
const nodemailer = require('nodemailer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const port = 3000; // Change to your desired port number

// File paths in /tmp (writable in Render during runtime)
const counterPath = '/tmp/alertIdCounter.json';
const alertMappingPath = '/tmp/alertMapping.json';

// Middleware to parse JSON bodies
app.use(express.json());

// In-memory variables for counter and mapping
let alertIdCounter = 100; // Start from 100 or any number you want
let alertMapping = {};

// Load alertIdCounter and alertMapping from files on startup if they exist
try {
  const counterData = fs.readFileSync(counterPath, 'utf-8');
  alertIdCounter = JSON.parse(counterData).counter || 100;
  console.log(`Loaded alertIdCounter: ${alertIdCounter}`);
} catch (err) {
  console.log('Counter file not found, starting alertIdCounter at 100');
}

try {
  const mappingData = fs.readFileSync(alertMappingPath, 'utf-8');
  alertMapping = JSON.parse(mappingData);
  console.log(`Loaded alertMapping with ${Object.keys(alertMapping).length} entries`);
} catch (err) {
  console.log('Alert mapping file not found, starting with empty mapping');
}

// Save functions to persist data back to /tmp files
function saveCounter() {
  fs.writeFileSync(counterPath, JSON.stringify({ counter: alertIdCounter }));
}

function saveMapping() {
  fs.writeFileSync(alertMappingPath, JSON.stringify(alertMapping));
}

// GET endpoint for testing
app.get('/webhook', async (req, res) => {
  console.log('GET request received');
  res.status(200).send("GET Reached");
});

// POST endpoint to handle webhook, send email, and create a work item
app.post('/webhook', async (req, res) => {
  console.log('POST request received');
  try {
    const payload = req.body;
    console.log('Request Payload:', payload);

    if (!payload.title || !payload.message) {
      console.log('Invalid payload:', payload);
      return res.status(400).send('Invalid payload');
    }

    // The unique key we'll use to identify alerts - use fingerprint or groupKey or any unique field
    const alertKey = payload.groupKey || (payload.alerts && payload.alerts[0] && payload.alerts[0].fingerprint);
    if (!alertKey) {
      return res.status(400).send('No unique alert key found in payload');
    }

    // Generate or get alertId from mapping
    let alertId;
    if (alertMapping[alertKey]) {
      alertId = alertMapping[alertKey];
      console.log(`Found existing alertId for alertKey: ${alertKey} => ${alertId}`);
    } else {
      alertIdCounter++;
      const idNumber = alertIdCounter.toString().padStart(3, '0');
      alertId = `ALR-SWF-${idNumber}`;
      alertMapping[alertKey] = alertId;
      saveCounter();
      saveMapping();
      console.log(`Generated new alertId: ${alertId} for alertKey: ${alertKey}`);
    }

    // Modify the title by removing content inside parentheses
    let title = payload.title.replace(/\(.*\)/, '').trim();

    // Extract and filter the message part from the payload
    let message = payload.message.split('Annotations:')[0];
    message = message.replace(/Value: .*?(Messages_behind=\d+)/, 'Value: $1')
                     .replace(/(Messages_behind=\d+)/g, '<strong>$1</strong>');

    // Extract the 'summary' field from 'commonAnnotations'
    let summary = '';
    if (payload.commonAnnotations && payload.commonAnnotations.summary) {
      summary = payload.commonAnnotations.summary.trim();
      console.log('Extracted Summary:', summary);
    }

    // Get the status of the alert
    const status = payload.status || (payload.alerts && payload.alerts[0] && payload.alerts[0].status);

    if (status === 'firing' && summary) {
      message += `<br><strong>Summary:</strong> <span style="color: red;">${summary}</span>`;
    }

    // If alert is resolved, close the ADO ticket
    if (status === 'resolved') {
      await closeWorkItem(alertId);
      res.status(200).send(`Alert resolved. Work item closed for Alert ID: ${alertId}`);
      return;
    }

    // Send email
    await sendEmail(alertId, title, message);

    // Create or update ADO work item
    const workItemData = { title: `${alertId} - ${title}`, description: message };
    const response = await createOrUpdateWorkItem(alertId, workItemData);

    res.status(200).send(`Alert email sent and work item processed successfully. Alert ID: ${alertId}`);
  } catch (error) {
    console.error('Error:', error.response ? error.response.data : error.message);
    res.status(500).send('Error processing webhook');
  }
});

// Function to send email
async function sendEmail(alertId, title, message) {
  const transporter = nodemailer.createTransport({
    service: 'Outlook',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  message = message.replace(/Value:/g, '<strong>Value:</strong>')
                   .replace(/Labels:/g, '<strong>Labels:</strong>')
                   .replace(/ - /g, '<strong> - </strong>');

  const footer = `<br><br><strong><em>This Alert is Generated By Software Factory Team</em></strong>
                  <br><img src="https://mspmovil.com/en/wp-content/uploads/software-factory.png" alt="Software Factory Logo" width="142" height="60" />
                  <br><strong>Message ID:</strong> ${alertId}`;

  const recipients = [
    process.env.EMAIL_TO,
    process.env.EMAIL_TO_1,
    process.env.EMAIL_TO_2,
  ].filter(Boolean).join(', ');

  const mailOptions = {
    from: process.env.EMAIL_FROM,
    to: recipients,
    subject: `${title}`,
    html: `<p><strong>Title:</strong> <b>${title}</b></p>
           <p><strong>Message:</strong></p>
           <pre style="white-space: pre-wrap;">${message}</pre>
           ${footer}`,
  };

  await transporter.sendMail(mailOptions);
  console.log(`Email sent successfully to all recipients. Message ID: ${alertId}`);
}

// Function to create or update Azure DevOps work item
async function createOrUpdateWorkItem(alertId, workItemData) {
  const organization = 'TICMPL';
  const project = 'Training';
  const personalAccessToken = process.env.PAT;
  const type = 'Bug';

  // Here you can implement logic to search for an existing work item by alertId in title or custom field
  // For now, let's always create a new work item for firing alerts

  const url = `https://dev.azure.com/${organization}/${project}/_apis/wit/workitems/$${type}?api-version=6.0`;

  const workItemFields = [
    { op: 'add', path: '/fields/System.Title', value: workItemData.title },
    { op: 'add', path: '/fields/System.Description', value: workItemData.description },
  ];

  const config = {
    headers: {
      'Content-Type': 'application/json-patch+json',
      Authorization: `Basic ${Buffer.from(`:${personalAccessToken}`).toString('base64')}`,
    },
  };

  const response = await axios.post(url, workItemFields, config);
  console.log('Work item created:', response.data);
  return response;
}

// Function to close Azure DevOps work item by searching with alertId in title
async function closeWorkItem(alertId) {
  const organization = 'TICMPL';
  const project = 'Training';
  const personalAccessToken = process.env.PAT;

  // Search for work item by alertId in title (simple WIQL query)
  const wiqlUrl = `https://dev.azure.com/${organization}/${project}/_apis/wit/wiql?api-version=6.0`;
  const wiqlQuery = {
    query: `Select [System.Id] From WorkItems Where [System.Title] Contains '${alertId}' And [System.State] <> 'Closed'`
  };
  const config = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`:${personalAccessToken}`).toString('base64')}`,
    },
  };

  const wiqlResponse = await axios.post(wiqlUrl, wiqlQuery, config);
  const workItems = wiqlResponse.data.workItems;
  if (!workItems || workItems.length === 0) {
    console.log(`No open work items found for alert ID ${alertId}`);
    return;
  }

  // Close all found work items
  for (const item of workItems) {
    const workItemId = item.id;
    const updateUrl = `https://dev.azure.com/${organization}/${project}/_apis/wit/workitems/${workItemId}?api-version=6.0`;
    const closePayload = [
      { op: 'add', path: '/fields/System.State', value: 'Closed' },
      { op: 'add', path: '/fields/System.Reason', value: 'Resolved' }
    ];

    await axios.patch(updateUrl, closePayload, config);
    console.log(`Closed work item ID: ${workItemId} for alert ID: ${alertId}`);
  }
}

// Start the server
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
