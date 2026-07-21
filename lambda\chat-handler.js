const AWS = require('aws-sdk');
const https = require('https');

// Initialize AWS services
const dynamodb = new AWS.DynamoDB.DocumentClient();

// Environment variables
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DYNAMODB_TABLE = process.env.DYNAMODB_TABLE || 'InteractionLogs';
const CORS_ORIGINS = process.env.CORS_ORIGINS || '*';

// CORS headers
const corsHeaders = {
  'Access-Control-Allow-Origin': CORS_ORIGINS,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
};

// OpenAI API call function
function callOpenAI(message) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: message }],
      max_tokens: 150
    });

    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      
      res.on('data', (chunk) => {
        responseData += chunk;
      });
      
      res.on('end', () => {
        try {
          const parsed = JSON.parse(responseData);
          if (res.statusCode === 200) {
            resolve(parsed.choices[0].message.content);
          } else {
            reject(new Error(`OpenAI API error: ${parsed.error?.message || 'Unknown error'}`));
          }
        } catch (error) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    req.on('error', (error) => {
      reject(error);
    });

    req.write(data);
    req.end();
  });
}

// DynamoDB logging function
async function logInteraction(message, response, timestamp) {
  const params = {
    TableName: DYNAMODB_TABLE,
    Item: {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: timestamp,
      message: message,
      response: response,
      createdAt: new Date().toISOString()
    }
  };

  try {
    await dynamodb.put(params).promise();
  } catch (error) {
    console.error('Failed to log interaction:', error);
    // Don't throw - logging failure shouldn't break the main flow
  }
}

// Main Lambda handler
exports.handler = async (event) => {
  console.log('Received event:', JSON.stringify(event, null, 2));

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: ''
    };
  }

  // Handle health check
  if (event.httpMethod === 'GET' && event.path === '/') {
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString()
      })
    };
  }

  // Handle chat endpoint
  if (event.httpMethod === 'POST' && event.path === '/chat') {
    try {
      // Validate request body
      if (!event.body) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'Request body is required'
          })
        };
      }

      let requestBody;
      try {
        requestBody = JSON.parse(event.body);
      } catch (error) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'Invalid JSON in request body'
          })
        };
      }

      const { message } = requestBody;
      if (!message || typeof message !== 'string') {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'Message field is required and must be a string'
          })
        };
      }

      // Check for OpenAI API key
      if (!OPENAI_API_KEY) {
        return {
          statusCode: 503,
          headers: corsHeaders,
          body: JSON.stringify({
            error: 'OpenAI API key not configured'
          })
        };
      }

      const timestamp = Date.now();
      
      // Call OpenAI API
      const aiResponse = await callOpenAI(message);
      
      // Log interaction to DynamoDB
      await logInteraction(message, aiResponse, timestamp);
      
      // Return successful response
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          response: aiResponse,
          timestamp: timestamp
        })
      };
      
    } catch (error) {
      console.error('Error processing chat request:', error);
      
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          error: 'Internal server error'
        })
      };
    }
  }

  // Handle unknown routes
  return {
    statusCode: 404,
    headers: corsHeaders,
    body: JSON.stringify({
      error: 'Not found'
    })
  };
};