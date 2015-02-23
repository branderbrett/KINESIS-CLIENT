/**
 * @fileoverview Cluster manager.
 */

var EventEmitter = require('events').EventEmitter
var nodeCluster = require('cluster')
var path = require('path')
var util = require('util')

var _ = require('underscore')
var async = require('async')
var bunyan = require('bunyan')

var aws = require('./lib/aws/factory')
var config = require('./lib/config')
var kinesis = require('./lib/aws/kinesis')
var models = require('./lib/models')
var server = require('./lib/server')

var AWS_KINESIS_ERROR_CODES = {
  ERR_CHECK_COALITION: 'ConditionalCheckFailedException',
}

module.exports = ConsumerCluster

/**
 * Cluster of consumers.
 *
 * @param {string}  pathToConsumer  Filesystem path to consumer script.
 * @param {Object}  opts
 */
function ConsumerCluster(pathToConsumer, opts) {
  EventEmitter.call(this)

  this.opts = opts
  this.logger = bunyan.createLogger({name: 'KinesisCluster'})

  nodeCluster.setupMaster({
    exec: pathToConsumer,
    silent: true
  })

  this.cluster = new models.Cluster(opts.tableName, opts.awsConfig, opts.localDynamo)

  this.client = aws.create(opts.awsConfig, false, 'Kinesis')

  this.hasStartedReset = false
  this.externalNetwork = {}
  this.consumers = {}
  this.consumerIds = []

  this.lastGarbageCollectedAt = Date.now()
}
util.inherits(ConsumerCluster, EventEmitter)

/**
 * Setup the initial cluster state.
 */
ConsumerCluster.prototype.init = function () {
  var _this = this

  async.auto({
    tableExists: function (done) {
      var tableName = _this.opts.tableName
      var awsConfig = _this.opts.awsConfig
      var localDynamo = _this.opts.localDynamo
      models.Cluster.tableExists(tableName, awsConfig, localDynamo, done)
    },

    createTable: ['tableExists', function (done, data) {
      if (data.tableExists) return done()

      var tableName = _this.opts.tableName
      var awsConfig = _this.opts.awsConfig
      var capacity = _this.opts.capacity || {}
      var localDynamo = !! _this.opts.localDynamo

      _this.logger.info({table: tableName}, 'Creating DynamoDB table')
      models.Cluster.createTable(tableName, awsConfig, capacity, localDynamo, done)
    }]
  }, function (err) {
    if (err) {
      _this.logger.error(err, 'Error ensuring Dynamo table exists')

      return _this._killAllConsumers(err)
    }

    _this._bindListeners()
    _this._loopReportClusterToNetwork()
    _this._loopFetchExternalNetwork()
  })
}

/**
 * Run an HTTP server. Useful as a health check.
 *
 * @param {(string|number)}  port
 */
ConsumerCluster.prototype.serveHttp = function (port) {
  this.logger.debug('Starting HTTP server on port %s', port)
  server.create(port, function () {
    return this.consumerIds.length
  }.bind(this))
}

/**
 * Setup listeners fro internal events.
 */
ConsumerCluster.prototype._bindListeners = function () {
  var _this = this

  this.on('updateNetwork', function () {
    _this._garbageCollectClusters()

    if (_this._shouldTryToAcquireMoreShards()) {
      _this.logger.debug('Should try to acquire more shards')
      _this.fetchAvailableShard()
    } else if (_this._hasTooManyShards()) {
      _this.logger.debug({consumerIds: _this.consumerIds}, 'Have too many shards')
      _this._killConsumer()
    }
  })

  this.on('availableShard', function (shardId, leaseCounter) {
    // Stops accepting consumers, since the cluster will be reset based one an error
    if (_this.hasStartedReset) return

    _this.spawn(shardId, leaseCounter)
  })
}

/**
 * Compare cluster state to external network to figure out if we should try to
 * change our shard allocation.
 */
ConsumerCluster.prototype._shouldTryToAcquireMoreShards = function () {
  if (this.consumerIds.length === 0) {
    return true
  }

  var externalNetwork = this.externalNetwork
  var networkKeys = Object.keys(externalNetwork)
  if (networkKeys.length === 0) {
    return true
  }

  var lowestInOutterNetwork = networkKeys.reduce(function (memo, key) {
    var count = externalNetwork[key]
    if (count < memo) {
      memo = count
    }

    return memo
  }, Infinity)

  return this.consumerIds.length <= lowestInOutterNetwork
}

/**
 * Determine if we have too many shards compared to the rest of the network.
 * @return {Boolean}
 */
ConsumerCluster.prototype._hasTooManyShards = function () {
  var externalNetwork = this.externalNetwork

  var networkKeys = Object.keys(externalNetwork)
  if (networkKeys.length === 0) return false

  var lowestInOutterNetwork = networkKeys.reduce(function (memo, key) {
    var count = externalNetwork[key]
    if (count < memo) {
      memo = count
    }

    return memo
  }, Infinity)

  return this.consumerIds.length > (lowestInOutterNetwork + 1)
}

/**
 * Fetch data about unleased shards.
 */
ConsumerCluster.prototype.fetchAvailableShard = function () {
  var _this = this
  async.parallel({
    allShardIds: function (done) {
      kinesis.listShards(_this.client, _this.opts.streamName, function (err, shards) {
        if (err) return done(err)

        var shardIds = _.pluck(shards, 'ShardId')
        done(null, shardIds)
      })
    },
    leases: function (done) {
      var tableName = _this.opts.tableName
      var awsConfig = _this.opts.awsConfig
      var localDynamo = !!_this.opts.localDynamo
      models.Lease.fetchAll(tableName, awsConfig, localDynamo, function (err, leases) {
        if (err) return done(err)

        return done(null, leases.Items)
      })
    }
  }, function (err, data) {
    if (err) {
      return _this.logger.error(err, 'Error fetching available shards')
    }

    var finishedShardIds = data.leases.filter(function (lease) {
      return lease.get('isFinished')
    })

    var allUnfinishedShardIds = data.allShardIds.filter(function (id) {
      return finishedShardIds.indexOf(id) === -1
    })

    var leasedShardIds = data.leases.map(function (item) {
      return item.get('id')
    })
    var newShardIds = _.difference(allUnfinishedShardIds, leasedShardIds)

    // If there are shards theat have not been leased, pick one
    if (newShardIds.length > 0) {
      _this.logger.info({newShardIds: newShardIds}, 'Unleased shards available')
      return _this.emit('availableShard', newShardIds[0], null)
    }

    // Try to find the first expired lease
    var currentLease
    for (var i = 0; i < data.leases.length; i++) {
      currentLease = data.leases[i]
      if (currentLease.get('expiresAt') > Date.now()) continue
      if (currentLease.get('isFinished')) continue

      var shardId = currentLease.get('id')
      var leaseCounter = currentLease.get('leaseCounter')
      _this.logger.info({shardId: shardId, leaseCounter: leaseCounter}, 'Found available shard')
      return _this.emit('availableShard', shardId, leaseCounter)
    }
  })
}

/**
 * Create a new consumer processes.
 *
 * @param {string}  shardId
 * @param {number}  leaseCounter
 */
ConsumerCluster.prototype.spawn = function (shardId, leaseCounter) {
  if (!shardId) {
    return _this.logger.error('Cannot spawn consumer without shard ID')
  }

  this.logger.info({shardId: shardId, leaseCounter: leaseCounter}, 'Spawning consumer')
  var consumerOpts = {
    tableName: this.opts.tableName,
    awsConfig: this.opts.awsConfig,
    streamName: this.opts.streamName,
    startingIteratorType: (this.opts.startingIteratorType || '').toUpperCase(),
    shardId: shardId,
    leaseCounter: leaseCounter,
    localDynamo: this.opts.localDynamo
  }

  var env = {
    CONSUMER_INSTANCE_OPTS: JSON.stringify(consumerOpts),
    CONSUMER_SUPER_CLASS_PATH: path.join(__dirname, 'AbstractConsumer.js')
  }

  var consumer = nodeCluster.fork(env)
  consumer.opts = consumerOpts
  consumer.process.stdout.pipe(process.stdout)
  consumer.process.stderr.pipe(process.stderr)
  this._addConsumer(consumer)
}

/**
 * Add a consumer to the cluster.
 * @param {ChildProcess}  consumer
 */
ConsumerCluster.prototype._addConsumer = function (consumer) {
  this.consumerIds.push(consumer.id)
  this.consumers[consumer.id] = consumer

  consumer.once('exit', function (code) {
    var logMethod = code === 0 ? 'info' : 'error'
    this.logger[logMethod]({shardId: consumer.opts.shardId, exitCode: code}, 'Consumer exited')

    this.consumerIds = _.without(this.consumerIds, consumer.id)
    delete this.consumers[consumer.id]
  }.bind(this))
}

/**
 * Kill a consumer in the cluster.
 *
 * @param {Number} consumer identifier
 * @param  {Function} callback
 */
ConsumerCluster.prototype._killConsumer = function (consumerId, callback) {
  var id = consumerId || this.consumerIds[0]

  this.logger.info({id: id}, 'Killing consumer')
  this.consumers[id].send(config.shutdownMessage)

  // Kills consumer in 40 seconds, giving it enough time to consumer's shut down process
  // to finish
  setTimeout(function () {
    if (this.consumers[id]) {
      this.consumers[id].kill()

      if (callback) return callback()
    }
  }.bind(this), 40000).unref()
}

/**
 * Kills all consumers and then triggers the event to reset the cluster.
 *
 * @param {Error} error generated in some of the cluster processes
 */
ConsumerCluster.prototype._killAllConsumers = function (err) {
  if (this.hasStartedReset) return

  this.logger.info('Killing all consumers')

  this.hasStartedReset = true

  if (!this.consumerIds.length) return this.emit('error', err)

  var _this = this

  return async.each(_this.consumerIds, _this._killConsumer.bind(this), function () {
    throw new Error(err)
  });
}

/**
 * Continuously fetch data about the rest of the network.
 */
ConsumerCluster.prototype._loopFetchExternalNetwork = function () {
  var _this = this
  this.logger.info('Starting external network fetch loop')

  function fetchThenWait(done) {
    _this._fetchExternalNetwork(function (err) {
      if (err) return done(err)
      setTimeout(done, 5000)
    })
  }

  function handleError(err) {
    _this.logger.error(err, 'Error fetching external network data')
  }

  async.forever(fetchThenWait, handleError)
}

/**
 * Fetch data about the rest of the network.
 * @param  {Function}  callback
 */
ConsumerCluster.prototype._fetchExternalNetwork = function (callback) {
  var _this = this

  this.cluster.fetchAll(function (err, clusters) {
    if (err) return callback(err)

    _this.externalNetwork = clusters.Items.filter(function (cluster) {
      return cluster.get('id') !== _this.cluster.id
    }).reduce(function (memo, cluster) {
      memo[cluster.get('id')] = cluster.get('activeConsumers')
      return memo
    }, {})

    _this.logger.debug({externalNetwork: _this.externalNetwork}, 'Updated external network')
    _this.emit('updateNetwork')
    callback()
  })
}

/**
 * Continuously publish data about this cluster to the network.
 */
ConsumerCluster.prototype._loopReportClusterToNetwork = function () {
  var _this = this
  this.logger.info('Starting report cluster loop')
  function reportThenWait(done) {
    _this._reportClusterToNetwork(function (err) {
      if (err) return done(err)
      setTimeout(done, 1000)
    })
  }

  function handleError(err) {
    _this.logger.error(err, 'Error reporting cluster to network')
  }

  async.forever(reportThenWait, handleError)
}

/**
 * Publish data about this cluster to the nework.
 * @param {Function}  callback
 */
ConsumerCluster.prototype._reportClusterToNetwork = function (callback) {
  this.logger.debug({consumers: this.consumerIds.length}, 'Rerpoting cluster to network')
  this.cluster.reportActiveConsumers(this.consumerIds.length, callback)
}

/**
 * Garbage collect expired clusters from the network.
 */
ConsumerCluster.prototype._garbageCollectClusters = function () {
  if (Date.now() < (this.lastGarbageCollectedAt + (1000 * 60))) return

  this.lastGarbageCollectedAt = Date.now()
  this.cluster.garbageCollect(function (err, garbageCollectedClusters) {
    if (err) {
      this.logger.error(err, 'Error garbage collecting clusters, continuing cluster execution anyway')
      return
    }

    if (garbageCollectedClusters.length) {
      this.logger.info('Garbage collected %d clusters', garbageCollectedClusters.length)
    }
  }.bind(this))
}
