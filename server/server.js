#!/usr/bin/env node

const { basicConfig: config, sysConfig } = require("../allconfigs");

process.title = config.name;
process.env.DEBUG = process.env.DEBUG || '*INFO* *WARN* *ERROR*';


const fs = require('fs');
const https = require('https');
const url = require('url');
const protoo = require('protoo-server');
const mediasoup = require('mediasoup');
const express = require('express');
const bodyParser = require('body-parser');
const { AwaitQueue, AwaitQueue } = require('awaitqueue');
const { RSA_NO_PADDING } = require("constants");
const Logger = require('../lib/logging');
const Room = require('../lib/room');


/**
 * Async `queue` ensures one user creating
 * a room at a time, also ensures a user
 * waits till his request is accepted
 * 
 * @type {AwaitQueue}
 */
const QUEUE = new AwaitQueue();

/** 
 * Map of rooms to be created
 * 
 * @type {Map<Number, Room>} 
 */
const ROOMS = new Map();

/**
 * HTTPS server variable
 * 
 * @type {https.Server}
 */
let SERVER;

/**
 * Express app variable
 * 
 * @type {Function}
 */
let EXPRESS;

/**
 * Protoo server variable
 * 
 * @type {protoo.WebSocketServer}
 */
let PROTOO;

/**
 * List of all mediasoup worker to use
 * each worker works on single core of cpu
 * Hence have count of worker equal to no. of 
 * cpu cores in the system.
 * 
 * @type {Array<mediasoup.Worker>}
 * 
 * Variable to have index of next worker 
 * to be use
 * 
 * @type {Number}
 */
const WORKERS = [];
const WORKERIDX = 0;


/**
 * Launching mediasoup workers.
 * Count specified in config.
 * 
 * @type {Void}
 */
async function startWorkers(){
    const { num } = sysConfig.noOfWorkers;

    // somelogings


    for(let idx = 0; idx < num; idx++){
        const worker = await mediasoup.createWorker({
            // logLevel: ,
            // logTags: ,
            // rtcMinPort: ,
            // rtcMaxPort: ,
        });
        
        // observing events like `died` of worker 
        worker.on('died', () => {
            logger.error(
                'mediasoup Worker [pid: %d] died, exiting in 2 seconds.', worker.pid
            )
            setTimeout(() => process.exit(1), 2000);
        });

        WORKERS.push(worker);

    }
}

/**
 * Express App handling all the api requests
 * 
 * @type {Void}
 */
async function startExpress(){
    logger.info('starting Express App...');

    EXPRESS = express();
    EXPRESS.use(bodyParser.json());
    
    /**
     * for all API request, verify that the roomId
     * in the path exists and is valid too.
     */
    EXPRESS.param('roomId', (req, res, next, roomId) => {
        // The room must exists for all requests
        if(!ROOMS.has(roomId)){
            const error = new Error(`room with id "${roomId} does not exists`);
            error.status = 404;
            throw error;
        }
        req.room = ROOMS.get(roomID);
        next();
    });

    /**
     * API GET resuorce that returns the mediasoup
     * router RTP capablities of the room requested
     */
    EXPRESS.get('/room/:roomId', (req, res) => {
        const data = req.room.getRouterRTPCapablities();

        res.status(200).json(data);
    });

    /**
     * POST API to create a cine broadcaster
     */
    EXPRESS.post('/room/:roomId/heyIBroadcaster', async (req, res, next) => {

        const {
            id,
            displayName,
            device,
            rtpCapablities
        } = req.body;

        try {
            const data = await req.room.newBroadcaster({
                id, displayName, device, rtpCapablities,
            });

            res.status(200).json(data);
        } catch (error) {
            next(error);
        }

    });

    /**
     * DELETE API to delete a broadcaster.
     */
    EXPRESS.delete('/room/:roomId/heyIBroadcaster/:id', (req, res) => {
        const {id} = req.param;
        req.room.deleteBroadcaster({ id });
        
        res.status(200).send("broadcaster deleted");
    });

    /**
     * POST API to create a mediasoup Transport associated
     * a broadcaster. It can be a PlainTransport or 
     * WebRtcTransport depending on the type parameters
     * in the body. There are also additional parameters
     * for PlainTransport.
     */
    EXPRESS.post('/room/:roomId/heyIBroadcaster/:id/transport', async (req, res, next) => {
        const { id } = req.param;
        const {
            type, 
            rtcpMux,
            comedia,
            sctpCapablities
        } = req.body;

        try {
            const data = await req.room.newBroadcasterTransport({
                id, type, rtcpMux, comedia, sctpCapablities
            });
            
            res.status(200).json(data);
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST API to connect a Transport belonging to 
     * broadcaster. Not needed for PlainTransport 
     * if it was created with comedia set to true
     */
    EXPRESS.post('/room/:roomId/heyIReciever/:broadcasterId/transport/:id', async (req, res, next) => {
        const { broadcasterId, id } = req.params;
        const { dtlsParameter } = req.body;

        try {
            const data = await req.room.connectToTransport({
                broadcasterId, id, dtlsParameter
            });
            
            res.status(200).json(data);
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST API to create a mediasoup Producer associated to a Broadcaster.
     * The exact Transport in which the Producer must be created is
     * signaled the URL path. Body parameters include kind and 
     * rtpParameters of the Producer.
     */
    EXPRESS.post('/room/:roomId/heyIBroadcaster/:broadcasterId/transport/:transportId/producer', async (req, res, next) => {
        const { broadcasterId, transportId } = req.params;
        const { kind, rtpParamters } = req.body();

        try {
            const data = await req.room.newBroadcasterProducer({
                broadcasterId, transportId, kind, rtpParamters
            });

            res.status(200).json(data);
        } catch (error) {
            next(error);
        }
    });

    /**
     * POST API to create a mediasoup Consumer associated 
     * to a broadcaster. The exact Transport in which the
     * consumer must be created is signaled in the url path
     * Query parameters must include the desired producerId 
     * to consume.
     */
    EXPRESS.post('/room/:roomId/heyIReciever/:broadcasterId/transport/:transportId/consume', async (req, res, next) => {
        const { broadcasterId, transportId } = req.params;
        const { producerId } = req.query; 

        try {
            const data = await req.room.newBroadcasterConsumer({
                broadcasterId, transportId, producerId
            });

            res.status(200).json(data);
        } catch (error) {
            next(error);
        }
    });

    /**
	 * POST API to create a mediasoup DataConsumer associated 
     * to a Broadcaster. The exact Transport in which the 
     * DataConsumer must be created is signaled in
	 * the URL path. Query body must include the 
     * desired producerId to consume.
	 */
	EXPRESS.post('/room/:roomId/broadcaster/:broadcasterId/transport/:transportId/consume/data', async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { dataProducerId } = req.body;

			try {
				const data = await req.room.createBroadcasterDataConsumer({
                    broadcasterId,
                    transportId,
                    dataProducerId
                });

				res.status(200).json(data);
			} catch (error) {
				next(error);
			}
		});
	
	/**
	 * POST API to create a mediasoup DataProducer associated 
     * to a Broadcaster. The exact Transport in which the 
     * DataProducer must be created is signaled in
	 */
	EXPRESS.post('/room/:roomId/broadcaster/:broadcasterId/transport/:transportId/produce/data', async (req, res, next) => {
			const { broadcasterId, transportId } = req.params;
			const { label, protocol, sctpStreamParameters, appData } = req.body;

			try{
				const data = await req.room.createBroadcasterDataProducer({
                    broadcasterId,
                    transportId,
                    label,
                    protocol,
                    sctpStreamParameters,
                    appData
                });

				res.status(200).json(data);
			} catch (error) {
				next(error);
			}
		});

	/**
	 * Error handler.
	 */
	expressApp.use((error, req, res, next) =>{
        if (error) {
            logger.warn('Express app %s', String(error));

            error.status = error.status || (error.name === 'TypeError' ? 400 : 500);

            res.statusMessage = error.message;
            res.status(error.status).send(String(error));
        } else {
            next();
        }
    });

}


/**
 * Create a Node.js HTTPS server. It listens in the IP 
 * and port given in the configuration file and reuses 
 * the Express application as request listener.
 */
async function startHTTPS(){
	logger.info('running an HTTPS server...');

	// HTTPS server for the protoo WebSocket server.
	const tls = {
		cert : fs.readFileSync(config.https.tls.cert),
		key  : fs.readFileSync(config.https.tls.key)
	};

	SERVER = https.createServer(tls, EXPRESS);

	await new Promise((resolve) => {
		httpsServer.listen(Number(config.https.listenPort), config.https.listenIp, resolve);
	});
}

/**
 * Create a protoo WebSocketServer to allow WebSocket connections from browsers.
 */
async function startProtoo() {
	logger.info('running protoo WebSocketServer...');

	// Create the protoo WebSocket server.
	protooWebSocketServer = new protoo.WebSocketServer(httpsServer, {
        maxReceivedFrameSize     : 960000, // 960 KBytes.
        maxReceivedMessageSize   : 960000,
        fragmentOutgoingMessages : true,
        fragmentationThreshold   : 960000
    });

	// Handle connections from clients.
	protooWebSocketServer.on('connectionrequest', (info, accept, reject) => {
		// The client indicates the roomId and peerId in the URL query.
		const u = url.parse(info.request.url, true);
		const roomId = u.query['roomId'];
		const peerId = u.query['peerId'];

		if (!roomId || !peerId) {
			reject(400, 'Connection request without roomId and/or peerId');

			return;
		}

		logger.info('protoo connection request [roomId:%s, peerId:%s, address:%s, origin:%s]',
			roomId, peerId, info.socket.remoteAddress, info.origin);

		// Serialize this code into the queue to avoid that two peers connecting at
		// the same time with the same roomId create two separate rooms with same
		// roomId.
		queue.push(async () => {
			const room = await getOrCreateRoom({ roomId });

			// Accept the protoo WebSocket connection.
			const protooWebSocketTransport = accept();

			room.handleProtooConnection({ peerId, protooWebSocketTransport });
		})
        .catch((error) => {
            logger.error('room creation or room joining failed:%o', error);

            reject(error);
        });
	});
}

/**
 * Get next mediasoup Worker.
 */
function getMediasoupWorker() {
	const worker = mediasoupWorkers[nextMediasoupWorkerIdx];

	if (++nextMediasoupWorkerIdx === mediasoupWorkers.length)
		nextMediasoupWorkerIdx = 0;

	return worker;
}

/**
 * Get a Room instance (or create one if it does not exist).
 */
async function getOrCreateRoom({ roomId }) {
	let room = rooms.get(roomId);

	// If the Room does not exist create a new one.
	if (!room) {
		logger.info('creating a new Room [roomId:%s]', roomId);

		const mediasoupWorker = getMediasoupWorker();

		room = await Room.create({ mediasoupWorker, roomId });

		ROOMS.set(roomId, room);
		room.on('close', () => ROOMS.delete(roomId));
    }
    
	return room;
}

// initiating all process
async function startserver(){
    await startWorkers();
    await startExpress();
    await startHTTPS();
    await startProtoo();

    // doing some loging here.. every X sec
    setInterval(()=>{
        for(const room of ROOMS.values()){
            room.logStatus();
        }
    }, sysConfig.logInterval);

    setInterval(()=>{
        for(const worker of WORKERS){
            const usage = await worker.getResourceUsage();

			logger.info('mediasoup Worker resource usage [pid:%d]: %o', worker.pid, usage);
        }
    }, sysConfig.logInterval);


}

startserver();
