const config = require('./config');
const http = require('http');
const hostname = '127.0.0.1';
const port = config.host_port;

// Send request to the RPC server of the node and record response
send = (json_string) => {

    return new Promise((resolve, reject) => {
        const requestOptions = {
            host: config.node.rpc.address,
            port: config.node.rpc.port,
            method: 'POST',
            path: '/'
        };

        const request = http.request(requestOptions, response => {
            if (response.statusCode < 200 || response.statusCode > 299) {
                reject(new Error("Failed to fetch URL. Status code: " + response.statusCode));
            }

            const body = [];

            response.on("data", chunk => {
                body.push(chunk);
            });

            response.on("end", () => {
                const data = body.join("");
                try {
                    return resolve(data);
                } catch (e) {
                    reject(e);
                }
            });
        });

        request.on("error", e => {
            reject(e);
        });

        request.write(json_string);
        request.end();
    });
};

const WS = require('ws');
const ReconnectingWebSocket = require('reconnecting-websocket');
const dpow_wss = new ReconnectingWebSocket(config.dpow.ws_address, [], {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 100000,
    maxReconnectionDelay: 2000,
    minReconnectionDelay: 10 // if not set, initial connection will take a few seconds by default
});

let id = 0;
let using_dpow = false;
var dpow_request_map = {};
dpow_wss.onopen = () => {
    using_dpow = true;

    // dPOW sent us a message
    dpow_wss.onmessage = msg => {
        let data_json = JSON.parse(msg.data);
        console.log(data_json);

        let value_l = dpow_request_map[data_json.id];
        if (!data_json.hasOwnProperty("error")) {

            let new_response = {};
            new_response.work = data_json.work;
            new_response.hash = value_l.hash;
            value_l.res.end(JSON.stringify(new_response));
        } else {
            // dPOW failed to create us work, ask the node to generate it for us (TODO untested)
            let request = {};
            request.action = "work_generate";
            request.hash = value_l.hash;

            send(JSON.stringify(request))
                .then(rpc_response => {
                    value_l.res.end(rpc_response);
                })
                .catch(e => {
                    value_l.res.end('{"error":"1"}');
                });
        }
        delete dpow_request_map[data_json.id];
    };
};
const server = http.createServer((req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    let data = [];
    req.on('data', chunk => {
        data.push(chunk);
    });
    req.on('end', () => {
        let obj = JSON.parse(data);
        let action = obj.action;

        // The only RPC commands which are allowed
        const allowed_actions = ["account_info", "account_balance", "block_info", "pending", "process", "work_generate"];
        if (action == "request_nano") {

            let send_obj = {};
            send_obj.action = "send";
            send_obj.wallet = config.node.wallet;
            send_obj.source = config.node.source;
            send_obj.destination = obj.account;
            send_obj.amount = config.node.request_raw_amount;
            let send_rpc_response;
            send(JSON.stringify(send_obj))
                .then(rpc_response => {
                    send_rpc_response = JSON.parse(rpc_response);

                    let account_info_obj = {};
                    account_info_obj.action = "account_info";
                    account_info_obj.account = obj.account;

                    send(JSON.stringify(account_info_obj))
                        .then(account_info_response_str => {

                            let account_info_response = JSON.parse(account_info_response_str);
                            let new_response = {};
                            new_response.account = obj.account;
                            new_response.amount = config.node.request_raw_amount;
                            new_response.send_hash = send_rpc_response.block;
                            if (account_info_response.hasOwnProperty("error")) {
                                // account doesn't exist so hasn't been opened yet
                                new_response.frontier = "0";
                            }
                            else {
                                new_response.frontier = account_info_response.frontier;
                            }

                            res.end(JSON.stringify(new_response));
                        });
                })
                .catch(e => {
                    res.end('{"error":"1"}');
                });
        } else if (action == "work_generate" && config.dpow.enabled && using_dpow) {
            // Send to the dpow server and return the same request
            ++id;
            const dpow_request = {
                "user": config.dpow.user,
                "api_key": config.dpow.api_key,
                "hash": obj.hash,
                "id": id
            };

            let value = {};
            value.res = res;
            value.hash = obj.hash;
            dpow_request_map[id] = value;

            // Send a request to the dpow server
            dpow_wss.send(JSON.stringify(dpow_request));

        } else if (allowed_actions.includes(action)) {
            // Just forward to RPC server. TODO: Should probably check for validity
            send(data.toString())
                .then(rpc_response => {
                    res.end(rpc_response);
                })
                .catch(e => {
                    res.end('{"error":"1"}');
                });
        }
        else {
            res.end('{"error":"1"}');
        }
    });
});

server.listen(port, hostname, () => {
    console.log(`Server running at http://${hostname}:${port}/`);
});

// Create a reconnecting WebSocket to the node.
const ws = new ReconnectingWebSocket(config.node.ws_address, [], {
    WebSocket: WS,
    connectionTimeout: 1000,
    maxRetries: 100000,
    maxReconnectionDelay: 2000,
    minReconnectionDelay: 10 // if not set, initial connection will take a few seconds by default
});

// Act as a websocket server for Unreal Engine clients
const WebSocket = require('ws');
const ws_server = new WebSocket.Server({
    port: config.websocket.host_port
});

ws.onopen = () => {
    // Subscribe to the websocket API of the node filtered only to the accounts we care about
    subscribe_to_accounts = (accounts, ws) => {
        const confirmation_subscription = {
            "action": "subscribe",
            "topic": "confirmation",
            "options": {
                "accounts": accounts
            }
        }
        ws.send(JSON.stringify(confirmation_subscription));
    };

    var accounts = [];

    // Listen for Unreal Engine clients connecting to us
    ws_server.on('connection', function connection(ws_server) {
        // Received a message from an Unreal Engine client
        ws_server.on('message', function incoming(message) {

            let json = JSON.parse(message);
            if (json.action == "register_account") {
                accounts.push(json.account);
                subscribe_to_accounts(accounts, ws);
            }
            else if (json.action == "unregister_account") {
                accounts = accounts.filter(item => item == json.account);
                subscribe_to_accounts(accounts, ws);
            }
            else {
                console.log('Other received: %s', message);
            }
        });

        // The node sent us a message
        ws.onmessage = msg => {
            data_json = JSON.parse(msg.data);

            if (data_json.topic === "confirmation") {
                // Send the whole thing we received to the client
                ws_server.send(msg.data);
            }
        };
    });
}
