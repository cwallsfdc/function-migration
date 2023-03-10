import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';

import Fastify from 'fastify'
const fastify = Fastify({
    logger: true
})
import proxy from '@fastify/http-proxy';
import jsforce from 'jsforce'; // TODO: Remove, replace w/ got or request
import got from 'got';

// REVIEWME: Config vars?
const orgId18ConfigVar = process.env.ORG_ID_18 || '00Dxx0000006JX6EAM';
const functionUrl = process.env.FUNCION_URL || 'http://localhost:8080';
const privateKey = process.env.PRIVATE_KEY || readFileSync(process.env.PRIVATE_KEY_FILEPATH || 'config/server.key', 'utf8');
const baseJwtOpts = {
    clientId: process.env.CONSUMER_KEY || '3MVG9AOp4kbriZOKr0ySjr6jBQ0P_QBBGi.UslJa3sn1Q8SvnJNSpRbTzzWNK2HeQTckv.VQD6jLrxO0A8t5N',
    privateKey: privateKey
}

fastify.register(proxy, {
    upstream: functionUrl,
    prefix: '/sync',
    preHandler: async (request, reply) => {
        const logger = request.log;
        const headers = request.headers;
        const { requestId, context, userContext } = await validateRequest(logger, headers);
        // FIxME: Log not available on originalReq
        const accessToken = await mintToken(logger, context, userContext);
        assembleFunctionRequest(headers, requestId, context, userContext, accessToken);
    }
})

function parseHeaders(headers) {
    const requestId = headers['x-request-id'];
    if (!requestId) {
        // TODO: Throwing results in 500, but we want a specific status code
        throw new Error('RequestId not found');
    }

    const authHeader = headers.authorization;
    if (!authHeader) {
        // TODO: Throwing results in 500, but we want a specific status code
        throw new Error('Authorization not found');
    }
    const accessToken = authHeader.substring(authHeader.indexOf(' ') + 1);

    const { context, userContext } = parseContexts(headers);

    return { requestId, accessToken, context, userContext };
}

function parseContexts(headers) {
    const contextHeaderBase64 = headers['x-context'];
    if (!contextHeaderBase64) {
        // TODO: Throwing results in 500, but we want a specific status code
        throw new Error('Context not found');
    }

    let contextHeaderStr;
    try {
        contextHeaderStr = Buffer.from(contextHeaderBase64, 'base64').toString('utf8');
    } catch (err) {
        throw new Error('Invalid Context format');
    }

    const contextHeader = JSON.parse(contextHeaderStr);
    const context = contextHeader.context;
    const userContext = contextHeader.userContext;
    return { context, userContext };
}

// Validate expected payload and that the function invoker is of the expected org
async function validateRequest(logger, headers) {
    const { requestId, accessToken, context, userContext } = parseHeaders(headers);
    if (!requestId) {
        // TODO: Throwing results in 500, but we want a specific status code
        throw new Error('RequestId not found');
    }
    logger.info(`Handling function request ${requestId}`);

    // TODO: Further validate context
    if (!context || !userContext) {
        // TODO: Throwing results in 500, but we want a specific status code
        throw new Error('Context is incomplete');
    }
    logger.info(`Handling function request to ${context.function}`);

    // Validate that the context's orgId matches the accessToken
    await validateCallerThrows(logger, userContext.salesforceBaseUrl, accessToken, userContext.orgId);

    return { requestId, accessToken, context, userContext };
}

async function mintToken(logger, context, userContext) {
    const jwtOpts =  {
        uri: `${userContext.salesforceBaseUrl}/services/oauth2/token`,
        user: userContext.username
    };

    if (jwtOpts.uri.includes('c.scratch.vf.force.com')) {
        jwtOpts.isTest = true;
    }

    if (process.env.SF_AUDIENCE) {
        jwtOpts.audience = process.env.SF_AUDIENCE;
    }

    let response;
    try {
        // Generate new accessToken; will throw if user does not have permissions for given Connected App
        response = await asyncGetToken(logger, Object.assign(baseJwtOpts, jwtOpts));
    } catch (err) {
        let errMsg = err.message;
        if (errMsg.includes('invalid_app_access')) {
            errMsg += `. Ensure that user ${userContext.username} is assigned to target Connected App`;
        }
        logger.error(errMsg);
        throw new Error(errMsg);
    }

    const accessToken = response.access_token;

    if (context.permissionSets && context.permissionSets.length > 0) {
        // REVIEWME: Move to activateSessionPermSet?
        const sfOpts = {
            accessToken,
            version: context.apiVersion,
            instanceUrl: response.instance_url,
        }
        const sfConnection = new jsforce.Connection();
        sfConnection.initialize(sfOpts);
        await activateSessionPermSet(logger, sfConnection, context.permissionSets);
    }

    return accessToken;
}

async function handleAsyncRequest(request, reply) {
    const logger = request.log;
    const headers = request.headers;
    const { requestId, accessToken, context, userContext } = parseHeaders(headers);
    logger.info(`Handling async function request ${requestId}`);

    const options = {
        headers,
        json: request.body,
    };
    let statusCode, response, extraInfo;
    try {
        // REVIEWME: Does the got lib auto-retry?
        const functionResponse = await got.post(functionUrl, options);
        statusCode = functionResponse.statusCode;
        response = functionResponse.body;
        extraInfo = functionResponse.headers['x-extra-info'];
    } catch (err) {
        logger.error(err.message);
        statusCode = 500;
        response = `${err.message} ${err.code}]`;
        if (err.response) {
            statusCode = err.response.statusCode;
            response = err.response.body;
            extraInfo = err.response.headers['x-extra-info'];
        }
    }

    // Post response to AFIR
    const sfOpts = {
        accessToken: accessToken,
        instanceUrl: userContext.salesforceBaseUrl,
        version: context.apiVersion
    }
    const sfConnection = new jsforce.Connection();
    sfConnection.initialize(sfOpts);

    try { // TODO: Ensure doesn't throw; if throws, catch and figure out what to do, eg retry
        const status = statusCode < 200 || statusCode > 299 ? 'ERROR' : 'SUCCESS';
        const afirUpdateResponse = await sobjectUpdate(
            logger,
            sfConnection,
            'AsyncFunctionInvocationRequest__c',
            {
                ExtraInfo__c: extraInfo,
                Id: context.asyncFunctionInvocationRequestId,
                Response__c: response,
                Status__c: status,
                StatusCode__c: statusCode,
            });
        // TODO: Iterate response array finding when !success
        if (afirUpdateResponse && !afirUpdateResponse.success) {
            logger.error(`Unable to save function response to AsyncFunctionInvocationRequest [${context.asyncFunctionInvocationRequestId}]: ${JSON.stringify(afirUpdateResponse.errors.join(','))}`);
        } else {
            logger.info(`Save function response [${statusCode}] to AsyncFunctionInvocationRequest [${context.asyncFunctionInvocationRequestId}]`);
        }
    } catch (err) {
        let errMsg = err.message;
        if (errMsg.includes('The requested resource does not exist')) {
            errMsg += `. Ensure that user ${userContext.username} has access to AsyncFunctionInvocationRequest__c.`;
        }
        logger.error(errMsg);
        throw new Error(errMsg);
    }
}

fastify.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode !== 201) {
        return;
    }

    const { context } = parseContexts(request.headers);
    if (context && 'com.salesforce.function.invoke.async' === context.type) {
        await handleAsyncRequest(request, reply);
    }
})

async function requestGet(logger, conn, url, options) {
    return new Promise((resolve, reject) => {
        conn.requestGet(url, options,(err, data) => {
            if (err) {
                logger.error(err);
                return reject(err);
            }
            resolve(data);
        });
    });
}
async function validateCallerThrows(logger, instanceUrl, accessToken, orgId) {
    const sfOpts = {
        accessToken,
        instanceUrl
    }
    const sfConnection = new jsforce.Connection();
    sfConnection.initialize(sfOpts);

    const response = await requestGet(logger, sfConnection, '/services/oauth2/userinfo', { });
    // TODO: Throwing results in 500, but we want a specific status code
    if (response && (orgId !== response.organization_id || orgId18ConfigVar != response.organization_id)) {
        throw new Error('Unauthorized request');
    }
}

async function requestPost(logger, conn, url, body, options) {
    return new Promise((resolve, reject) => {
        conn.requestPost(url, body, options,(err, data) => {
            if (err) {
                logger.error(err);
                return reject(err);
            }
            resolve(data);
        });
    });
}

// Borrowed from node-salesforce-jwt w/ a bug fix from the following pending PR.
// https://github.com/moshekarmel1/node-salesforce-jwt/pull/1
import request from 'request';
import jwt from 'jsonwebtoken';
function getToken(logger, opts, cb) {
    const testUrl = 'https://test.salesforce.com/services/oauth2/token';
    const prodUrl = 'https://login.salesforce.com/services/oauth2/token';
    const testAudience = 'https://test.salesforce.com';
    const prodAudience = 'https://login.salesforce.com';

    const isTest = opts.isTest === true;
    const options = {
        issuer: opts.clientId,
        audience: opts.audience || (isTest ? testAudience : prodAudience),
        expiresIn: opts.expiresIn || 360,
        algorithm: opts.algorithm || 'RS256'
    }

    const uri = opts.uri || (isTest ? testUrl : prodUrl);
    logger.info(`Getting ${isTest ? 'test ' : ' '}token for user ${opts.user}, audience ${options.audience}, uri ${uri}, issuer ${options.issuer.substring(0,5)}`);

    const token = jwt.sign({ prn: opts.user }, opts.privateKey, options);

    const post = {
        uri,
        form: {
            'grant_type': 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            'assertion':  token
        },
        method: 'post'
    }

    request(post, function(err, res, body) {
        if (err) {
            cb(err);
            return;
        }

        const reply = JsonTryParse(body);

        if (!reply) {
            cb(new Error('No response from oauth endpoint.'));
            return;
        }

        if (res.statusCode != 200) {
            const message = `Unable to authenticate: ${reply.error} (${reply.error_description})`;
            cb(new Error(message))
            return;
        }

        cb(null, reply);
    });
}

function JsonTryParse(string) {
    try {
        return JSON.parse(string);
    } catch (e) {
        return null;
    }
}
async function asyncGetToken(logger, jwtOpts) {
    return new Promise((resolve, reject) => {
        getToken(logger, jwtOpts, (err, response) => {
            if (err) {
                logger.error(err);
                return reject(err);
            }
            resolve(response);
        });
    });
}

async function activateSessionPermSet(logger, sfConnection, permissionSets) {
    if (!permissionSets || permissionSets.length == 0) {
        logger.info('No Permission Sets provided; skipping activation');
        return;
    }

    const inputs = [];
    permissionSets.forEach(permissionSet => {
       inputs.push({ PermSetName: permissionSet });
    });

    // Activate!
    let response;
    try {
        response = await requestPost(
            logger,
            sfConnection,
            '/actions/standard/activateSessionPermSet',
            {inputs: inputs}
        );
    } catch (err) {
        let errMsg = err.message;
        try {
            const errResponse = JSON.parse(errMsg);
            if (errResponse && errResponse.length > 0) {
                const errMsgs = [];
                // FIXME: Do array collect or whatever
                errResponse.forEach(e => e.errors.forEach(ee => errMsgs.push(`${ee.message} [${ee.statusCode}]`)));
                errMsg = errMsgs.join('; ')
            }
        } catch (parseErr) {
            // ignore
        }
        logger.error(errMsg);
        throw new Error(errMsg);
    }

    // TODO: Handle multiple Permission Set activations
    if (response && response.length == inputs.length && !response[0].isSuccess) {
        throw new Error(`Unable to activate Session-based Permission Set '${inputs[0].PermSetName}': ${JSON.stringify(response[0].errors)}`);
    } else {
        logger.info(`Successfully activated Session-based Permission Set: ${inputs[0].PermSetName}`);
    }
}

async function sobjectUpdate(logger, conn, sobject, values) {
    return new Promise((resolve, reject) => {
        conn.sobject(sobject).update(values, (err, data) => {
            if (err) {
                logger.error(err);
                return reject(err);
            }
            resolve(data);
        });
    });
}

function assembleFunctionRequest(headers, requestId, context, userContext, accessToken) {
    // Include function's org access token
    headers.authorization = `Bearer ${accessToken}`;
    context.accessToken = accessToken;
    // REVIEWME: x-context is replaced as ce-sfcontext and ce-sffncontext, remove?
    headers['x-context'] = Buffer.from(JSON.stringify({ context, userContext }), 'utf8').toString('base64');
    headers['ce-specversion'] = 1.0;
    headers['ce-id'] = requestId;
    headers['ce-source'] = context.source;
    headers['ce-type'] = context.type;
    headers['ce-time'] = (new Date()).toISOString();
    const sfcontext = {
        apiVersion: context.apiVersion,
        payloadVersion: '0.1',
        userContext
    }
    headers['ce-sfcontext'] = Buffer.from(JSON.stringify(sfcontext), 'utf8').toString('base64');
    const sffncontext = {
        accessToken,
        requestId,
        functionInvocationId: context.asyncFunctionInvocationRequestId,
        function: context.function
    }
    headers['ce-sffncontext'] = Buffer.from(JSON.stringify(sffncontext), 'utf8').toString('base64');
}

fastify.post('/async', async function (request, reply) {
    const logger = request.log;
    const headers = request.headers;
    const { requestId, context, userContext } = await validateRequest(logger, headers);
    if ('com.salesforce.function.invoke.async' != context.type) {
        throw new Error('Invalid request type');
    }
    // Mint token w/ JWT and apply session-based PermSets to accessToken
    const accessToken = await mintToken(logger, context, userContext);
    assembleFunctionRequest(headers, requestId, context, userContext, accessToken);
    reply.code(201);
});

fastify.listen({ host: '0.0.0.0', port: process.env.PORT || 3000 }, async (err, address) => {
    if (err) throw err

    //const asyncSpawn = promisify(spawn);
    const __dirname = path.resolve();
    const functionProcess = spawn('node',
        [
            `${__dirname}/../node_modules/@heroku/sf-fx-runtime-nodejs/bin/cli.js`,
            'serve',
            `${__dirname}/..`,
            '-p',
            process.env.FUNCTTION_PORT || 8080
        ], // TODO: '-d','9230'
        {});
    functionProcess.stdout.on('data', buff => {
        // REVIEWME: Prefix message w/ function name or add/change attribute to include function name?
        const line = buff.toLocaleString();
        console.info(line);
    });
    functionProcess.stderr.on('data', buff => { // also catch any error output
        // REVIEWME: Prefix message w/ function name or add/change attribute to include function name?
        const line = buff.toLocaleString();
        console.log(line);
    });
    functionProcess.on('error', err => { // also catch any error output
        // REVIEWME: Prefix message w/ function name or add/change attribute to include function name?
        console.errro(err.message);
    });
    functionProcess.on('exit', code => {
        // REVIEWME: Prefix message w/ function name or add/change attribute to include function name?
        console.log(`Function process exited with code ${code}`)
    });
});