var session = require('session');
var _ = require('underscore')._;
var async = require('async');
var users = require("users");
var $ = require('jquery');
$.couch = require('jquery.couch');
var url = require('url');

exports.dashboard_db_name = 'dashboard';
exports.dashboard_ddoc_name = 'dashboard';

$.couch.urlPrefix = '_couch';

exports.getGardenAppDetails = function(app_url, callback) {
    var app_json_url = app_details_json(app_url);
    $.ajax({
        url : app_json_url + "?callback=?",
        dataType : 'json',
        jsonp : true,
        success : function(remote_app_data) {
            remote_app_data.src = app_url
            callback(null, remote_app_data);
        },
        error : function() {
            callback('Error loading app details');
        }
    });
}

exports.install_app = function(remote_app_details, new_db_name, update_status_function, host_options, callback) {
    update_status_function('Installing App', '30%');
    async.waterfall([
        function(callback) {
            app_replicate(remote_app_details.db_src, new_db_name, remote_app_details.doc_id, callback);
        },
        function(callback) {
            update_status_function('Configuring App', '60%');
            var couch_db = $.couch.db(new_db_name);
            copyDoc(couch_db, remote_app_details.doc_id, '_design/' + remote_app_details.doc_id, false, callback);
        },
        function(callback) {
            update_status_function('Cleaning Up', '70%');
            var couch_db = $.couch.db(new_db_name);
            deleteDoc(couch_db, new_db_name, remote_app_details.doc_id, callback);
        },
        function(callback) {
            update_status_function('Recording Install', '85%');
            var dashboard_couch_db = $.couch.db(exports.dashboard_db_name);
            saveAppDetails(dashboard_couch_db, new_db_name, remote_app_details, callback);
        },
        function(install_doc, callback) {
            update_status_function('Setting security', '90%', true);
            if (install_doc.kanso.config.install_with_no_reader) {
                callback(null, install_doc);
            } else {
                var couch_db = $.couch.db(new_db_name);
                exports.addDBReaderRole(new_db_name, '_admin', function(err) {
                    callback(err, install_doc);
                });
            }
        },
        function(install_doc, callback) {
            if (host_options.short_app_urls) {
                update_status_function('Configuring URL', '98%', true);

                var to_bind_to = [];
                var hostnames = host_options.hostnames.split(',');
                _.each(hostnames, function(hostname){
                    var p = url.parse(hostname);
                    var to_bind = p.hostname;
                    if (p.port != '80' && (_.isString(p.port) || _.isNumber(p.port)) ) {
                        to_bind += ':' + p.port;
                    }
                    to_bind_to.push(to_bind);
                });


                addVhostRule(install_doc, to_bind_to, function(err) {
                    callback(err, install_doc);
                });
            } else {
                callback(null, install_doc);
            }
        }

    ], function(err, install_doc) {
        update_status_function('Install Complete', '100%', true);
        callback(err, install_doc);
    });

}

function app_replicate(src, target, doc_id, callback) {
    $.couch.replicate(src, target, {
            success : function() {
                return callback(null);
            },
            error : function() {
                return callback('error replicating');
            }
        }, {
       create_target:true,
       doc_ids : [doc_id]
    });
}

exports.getInstalledApps = function (db_name, callback) {

    // retrieve arguments as array
    var args = [];
    for (var i = 0; i < arguments.length; i++) {
        args.push(arguments[i]);
    }
    callback = args.pop();
    db_name = exports.dashboard_db_name;
    if (args.length > 0)  db_name = args.shift();


    $.couch.db(db_name).view(exports.dashboard_ddoc_name + '/by_active_install', {
        include_docs : true,
        success: function(response) {
            var apps = _.map(response.rows, function(row) {

                // we should verify these by checking the db and design docs exist.

                var app_data = row.doc;
                return {
                    id   : app_data._id,
                    img  : exports.bestIcon128(app_data),
                    name : app_data.dashboard_title,
                    doc_id : app_data.doc_id,
                    db   : app_data.installed.db,
                    start_url : exports.get_launch_url(app_data, window.location.pathname)
                }
            });
            callback(null, apps);
        }
    })
}

exports.getTopbarEntries = function(callback) {
    $.couch.db(exports.dashboard_db_name).view(exports.dashboard_ddoc_name + '/dashboard_assets', {
        include_docs : true,
        success: function(response) {
            callback(null, response.rows);
        }
    })
}

exports.getInstalledAppsByMarket = function(callback) {
    $.couch.db(exports.dashboard_db_name).view(exports.dashboard_ddoc_name + '/app_version_by_market', {
        include_docs : true,
        success: function(response) {
            // add flattr links
            var rows = _.map(response.rows, function(row) {
                if (flattr.hasFlattr(row.doc)) {
                    var flattrDetails = flattr.getFlattrDetailsFromInstallDoc(row.doc);
                    row.flattrLink = flattr.generateFlatterLinkHtml(flattrDetails);
                }
                return row;
            });



            var data = _.groupBy(rows, function(row) {
                return row.key;
            })
            callback(null,data);
        },
        error : function() {
            callback('cant get apps by market');
        }
    });
}

exports.checkUpdates = function(apps, callback){
    var checkLocation = apps.location + "/_db/_design/market/_list/app_versions/apps?callback=?";

    var ajaxReturned = false;
    setTimeout(function() {
        if (!ajaxReturned) callback(apps);
    }, 7000);

    $.ajax({
        url :  checkLocation,
        dataType : 'json',
        jsonp : true,
        success : function(remote_data) {
            ajaxReturned = true;
            apps.apps = _.map(apps.apps, function(app) {
                app.value.availableVersion = remote_data[app.value.app];
                app.value.needsUpdate = semver.lt(app.value.version, app.value.availableVersion);
                if (!app.value.needsUpdate) {
                    app.value.needsUpdate = false;
                }
                return app;
            });
            callback(null, apps);
        },
        error : function() {
            console.log('error');
            callback('cant get remote versions');
        }
    });
}

exports.updateApp = function(app_id, callback) {

    $.couch.db(exports.dashboard_db_name).openDoc(app_id, {
        success : function(app_data) {
            var db = $.couch.db(app_data.installed.db);
            async.waterfall([
                function(callback) {
                    app_replicate(app_data.db_src, app_data.installed.db, app_data.doc_id, callback);
                },
                function(callback) {
                    copyDoc(db, app_data.doc_id, '_design/' + app_data.doc_id, true, callback);
                },
                function(callback) {
                    deleteDoc(db, app_data.installed.db, app_data.doc_id, callback);
                },
                function(callback) {
                    exports.getGardenAppDetails(app_data.src, function(err, new_app_data) {
                        app_data.kanso = new_app_data.kanso;
                        $.couch.db(exports.dashboard_db_name).saveDoc(app_data, {
                           success: function() {
                               callback(null, app_data);
                           }
                        });
                    });
                }
            ], callback);
        },
        error : function(err) {
            callback(err);
        }
    })
}

exports.getMarkets = function(callback) {
    $.couch.db(exports.dashboard_db_name).view(exports.dashboard_ddoc_name + '/get_markets', {
        include_docs: true,
        success : function(response) {
            var markets =  _.map(response.rows, function(row) {
                return {
                    name : row.key,
                    url : row.value
                }
            });
            markets.push({
                type: 'market',
                name : "Garden20 Market",
                url : "http://garden20.com/market/"
            });

            markets = addDashboardUrl(markets);
            callback(null, markets);
        }
    });
}

exports.updateDashboard = function(callback) {
    $.couch.replicate('http://garden20.iriscouch.com/dashboard_seed', exports.dashboard_db_name, {
              success : function() {
                  callback();
              }
   }, {doc_ids : [ '_design/dashboard'  ] });
}



exports.getBaseURL = function (/*optional*/req) {
    if (req.query.baseURL) {
        return req.query.baseURL;
    }
    if (req.query.db && req.query.ddoc) {
        return '/' + req.query.db + '/_design/' + req.query.ddoc + '/_rewrite/';
    }

    if (_.include(req.path, '_rewrite')) {
        return '/' + req.path.slice(0, 3).join('/') + '/_rewrite';
    }
    if (req.headers['x-couchdb-vhost-path']) {
        return '';
    }
    return '/' + req.path.slice(0, 3).join('/') + '/_rewrite';
};


exports.isAdmin = function(req) {
    if (!req.userCtx) return false;
    if (!req.userCtx.name) return false;
    if (!req.userCtx.roles) return false;
    if (req.userCtx.roles.indexOf('_admin') === -1) return false;

    return true;
}


exports.isUser = function(req) {
    if (!req.userCtx) return false;
    if (!req.userCtx.name) return false;
    return true;
}

exports.getUsername = function(req) {
    return req.userCtx.name;
}



function app_details_json(app_details_url) {
    return app_details_url + '/json';
}


exports.incr_app_name = function(app_name) {
    var num = 1;
    var delim = app_name.lastIndexOf('_');
    if (delim > 0) {
        var last_num = app_name.substr(delim+1)
        if (last_num > 0) {
            num = Number(last_num) + 1;
            app_name = app_name.substr(0, delim);
        }
    }
    return app_name + "_" + num;
}



function user_app_name_to_safe_url(app_name) {
    // needs some help
    return app_name.toLowerCase().replace(/ /g,"_");
}

exports.best_db_name = function(app_name, callback) {
    var lower_app_name = app_name.toLowerCase();
    $.couch.allDbs({
        success : function(data) {
            var db_name = exports.find_next_db_name(lower_app_name, data);
            callback(null, db_name);
        },
        error : function() {
            callback("Problem getting the next db");
        }
    });
}

var fnd = exports.find_next_db_name = function(app_name, current_dbs) {

    if (!current_dbs) return app_name;
    if (!current_dbs.length) return app_name;

    if (current_dbs.indexOf(app_name) !== -1 ) {
        return fnd(exports.incr_app_name(app_name), current_dbs);
    }

    return app_name;
}


exports.get_launch_url = function(install_doc, window_path) {


    if (window_path && window_path.indexOf('/dashboard/_design/dashboard/_rewrite/') == 0) {
        return '/' + install_doc.installed.db + '/_design/' + install_doc.doc_id + '/_rewrite/'
    }

    if (install_doc.open_path && install_doc.open_path.indexOf('_rewrite') === -1) {
        return './' + install_doc.installed.db + '/_design/' + install_doc.doc_id + install_doc.open_path;
    }
    if (install_doc.kanso.config.legacy_mode  ) {
        return './' + install_doc.installed.db + '/_design/' + install_doc.doc_id + '/_rewrite/';
    }
    //return './' + install_doc.installed.db + '/_design/' + install_doc.doc_id + install_doc.open_path;
    return  user_app_name_to_safe_url(install_doc.dashboard_title) + '/'
    //return '../../../../' + install_doc.installed.db + '/_design/' + install_doc.doc_id +  install_doc.open_path;
}


exports.formatSize = function(size) {
    var jump = 512;
    if (size < jump) return size + " bytes";
    var units = ["KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    var i=0;
    while (size >= jump && i < units.length) {
        i += 1;
        size /= 1024;
    }
    return size.toFixed(1) + ' ' + units[i - 1];
}


exports.bestDashboardImage = function (install_doc) {
    try {
        if (install_doc.kanso.config.promo_images.small) {
            //http://ryan.garden20.com:5984/apps/wiki/wiki_2/_db/_design/wiki/icons/wiki_icon_128.png

            return  designDoc(install_doc) +   '/' + install_doc.kanso.config.promo_images.small;
        }
    } catch(e){}

    return 'http://placehold.it/210x150';
}


function designDoc(install_doc) {
    return './_couch/' + install_doc.installed.db +  '/_design/' +  install_doc.doc_id
    //return  './apps/' + safe(install_doc.dashboard_title) +  '/_db/_design/' +  install_doc.doc_id
}


exports.bestIcon96 = function(install_doc) {
    try {
        if (install_doc.kanso.config.icons['96']) {
            return designDoc(install_doc) +    '/' + install_doc.kanso.config.icons['96'];
        }
    } catch(e){}

    return 'http://placehold.it/96x96';
}

exports.bestIcon128 = function(install_doc) {
    try {
        if (install_doc.kanso.config.icons['128']) {
            return designDoc(install_doc) +   '/' + install_doc.kanso.config.icons['128'];
        }
    } catch(e){}

    return 'http://placehold.it/96x96';
}





exports.getDBSecurity = function(dbName, callback) {
    $.couch.db(dbName).getDbProperty("_security", {
      success: function(r) {
          callback(null, r);
      },
      error : function() {
          callback('cant get current db security on ' + dbName);
      }
  });
}


exports.addDBReaderRole = function(dbName, role, callback) {
  exports.getDBSecurity(dbName, function(err, sec) {
      if (err) return callback(err);
      if (!sec.admins) {
          sec = {"admins":{"names":[],"roles":[]},"members":{"names":[],"roles":[]}};
      }

      if (_.isArray(role)) {
          sec.members.roles = _.union(sec.members.roles, role);
      } else {
          sec.members.roles.push(role);
          sec.members.roles.push(role);
      }

      $.couch.db(dbName).setDbProperty("_security", sec, {
          success : function() {
              callback(null, sec);
          },
          error : function() {
              callback('cant add ' + role + ' to db ' + dbName);
          }
      });
  });
}

exports.onlyAdminDBReaderRole = function(dbName, callback) {
  exports.getDBSecurity(dbName, function(err, sec) {
      if (err) return callback(err);
      if (!sec.admins) {
          sec = {"admins":{"names":[],"roles":[]},"members":{"names":[],"roles":[]}};
      }
      sec.members.roles = ['_admin'];
      $.couch.db(dbName).setDbProperty("_security", sec, {
          success : function() {
              callback(null, sec);
          },
          error : function() {
              callback('cant add ' + role + ' to db ' + dbName);
          }
      });
  });
}

exports.removeAllDBReaderRoles = function(dbName, callback) {
  exports.getDBSecurity(dbName, function(err, sec) {
      if (err) return callback(err);
      if (!sec.admins) {
          sec = {"admins":{"names":[],"roles":[]},"members":{"names":[],"roles":[]}};
      }


      sec.members.roles = [];

      $.couch.db(dbName).setDbProperty("_security", sec, {
          success : function() {
              callback(null, sec);
          },
          error : function() {
              callback('cant add ' + role + ' to db ' + dbName);
          }
      });
  });
}

exports.removeDBReaderRole = function(dbName, role, callback) {
  exports.getDBSecurity(dbName, function(err, sec) {
      if (err) return callback(err);
      if (!sec.admins) {
          sec = {"admins":{"names":[],"roles":[]},"members":{"names":[],"roles":[]}};
      }


      sec.members.roles = _.without(sec.members.roles, role);

      $.couch.db(dbName).setDbProperty("_security", sec, {
          success : function() {
              callback(null, sec);
          },
          error : function() {
              callback('cant add ' + role + ' to db ' + dbName);
          }
      });
  });
}





function singleUpdateNavOrder(docID, order, onDropdownMenu, callback) {
    var url = '_db/_design/'+ exports.dashboard_ddoc_name +'/_update/updateNavOrder/' + docID +'?order=' + order;
    if (onDropdownMenu) url = url + '&onDropdownMenu=true'
    $.ajax({
        url : url ,
        type: 'PUT',
        success : function(result) {
            if (result == 'update complete') {
                return callback(null, result);
            }
            else return callback('update failed');

        },
        error : function() {
            return callback('update failed');
        }
    });
}

exports.updateNavOrdering = function(showingOrderedIDs, hiddenOrderedIDs, callback){
    var order = 1;
    async.forEach(showingOrderedIDs, function(id, callback) {
        singleUpdateNavOrder(id, order++, false, callback);
    }, function(err) {
        if (err) return callback(err);

        async.forEach(hiddenOrderedIDs, function(id, callback) {
                singleUpdateNavOrder(id, order++, true, callback);
        }, function(err){
            if (err) return callback(err);
            return callback(null);
        });
    });
}


function addVhostRule(install_doc, /* optional */ hosts, callback) {

    if (_.isFunction(hosts)) {
        callback = hosts;
        hosts = [location.host];
    }


    if (install_doc.kanso.config.legacy_mode) {
        return callback(null, {});
    } else {
        var safe_name = user_app_name_to_safe_url(install_doc.dashboard_title);
        var rewrite_url = appFullUrl(install_doc.installed.db, install_doc.doc_id, install_doc.open_path);

        _.each(hosts, function(host) {
            $.couch.config({
                success : function(result) {
                    callback(null, result);
                }
            }, 'vhosts', host + '/' + safe_name, rewrite_url );
        });


    }
}

function renameVhostRule(install_doc, old_name, callback) {
    var safe_name = user_app_name_to_safe_url(old_name);
    var add = function() {
        addVhostRule(app_data, function(err, result) {
            callback(err, result);
        })
    };
    // remove any old one
    $.couch.config({
        success : function() {
            add();
        },
        error : function() {
            add();
        }
    }, 'vhosts', appRewrite(safe_name), null );
}


function copyDoc(couch_db, from_doc_id, to_doc_id, update, callback) {

    var actualCopy = function(to_doc_id) {
        couch_db.copyDoc(
           from_doc_id,
           {
                error: function() {
                    callback('could not copy doc from ' + from_doc_id + ' to ' + to_doc_id);
                },
                success: function() {
                    callback(null);
                }
           },
           {
                headers : {Destination : to_doc_id}
            }
        );
    }

    if (update) {
        couch_db.headDoc(to_doc_id,{}, {
           success : function(data, status, jqXHR) {
               if (!jqXHR) callback('Update failed.');
               var rev = jqXHR.getResponseHeader('ETag').replace(/"/gi, '');
               to_doc_id += "?rev=" + rev;
               return actualCopy(to_doc_id);
           }
        })
    } else {
        return actualCopy(to_doc_id);
    }
}

function deleteDoc(couch_db, db_name, doc_id, callback) {
    couch_db.headDoc(doc_id, {}, {
        success : function(data, status, jqXHR) {
            var rev = jqXHR.getResponseHeader('ETag').replace(/"/gi, '');
            var purge_url = jQuery.couch.urlPrefix + '/' + db_name + '/_purge';
            var data = {};
            data[doc_id] = [rev];
            $.ajax({
              url : purge_url,
              data : JSON.stringify(data),
              dataType : 'json',
              contentType: 'application/json',
              type: 'POST',
              success : function(data) {
                  callback(null);
              },
              error : function() {
                  callback('a problem deleting the non prefixed doc');
              }
             });
        }
    });
}
function saveAppDetails(dashboad_couch_db, app_db_name, app_data, callback) {
    app_data.installed  = {
        date : new Date().getTime(),
        db : app_db_name
    }
    app_data.dashboard_title = app_db_name;
    app_data.type = 'install';
    dashboad_couch_db.saveDoc(app_data, {
        success : function() {
            callback(null, app_data)
        },
        error : function() {
            callback('cant save app details');
        }

    });
}

/**
 * this actively removes sync docs that have no replications
 * @param sync_overview
 * @param callback
 */

exports.cleanSyncRecords = function(sync_overview, callback) {
    var clean = [];

    async.forEach(sync_overview, function(sync_doc, cb){
        if (!sync_doc.replications || sync_doc.replications.length === 0) {
            $.couch.db(exports.dashboard_db_name).removeDoc(sync_doc, {
                success : function(){
                    cb(null);
                },
                error: function(err){
                    cb(err);
                }
            });
        } else {
            clean.push(sync_doc);
            cb();
        }
    }, function(err) {
        callback(err, clean);
    })
}

exports.sync_type_readable = {
    'bi-directional' : 'upload and download',
    'pull' : 'download only',
    'push' : 'upload only'
}

exports.getSyncDocs = function(callback){

    async.parallel({
        sync_docs : function(cb){
            $.couch.db(exports.dashboard_db_name).view(exports.dashboard_ddoc_name + '/get_syncs', {
                include_docs : true,
                success: function(response) {
                    cb(null, response.rows);
                }
            })
        },
        replication_docs : function(cb) {
            $.couch.db('_replicator').allDocs({
                include_docs : true,
                success: function(response) {
                    cb(null, _.filter(response.rows, function(row){ if (row.doc.sync_doc) return true;  }));
                }
            })
        }
    }, function(err, results){
        if (err) return callback(err);
        var replications_grouped_by_sync = _.groupBy(results.replication_docs, function(row){
            return row.doc.sync_doc;
        });
        var sync_overview = _.map(results.sync_docs, function(row){
            var doc = row.doc;
            doc.replications = replications_grouped_by_sync[doc._id];
            // get rid of the dashboard replication from the group list
            var temp = _.filter(doc.replications, function(row){  if(row.doc.sync_group) return true;   });
            doc.replications_group = _.map(
                _.groupBy(temp, function(row){
                    return row.doc.sync_group;
                }),
                function(value, key) {
                    var rep = { name: key, replications: value  }
                    rep.status_ok = true;
                    if (rep.replications[0].doc._replication_state == 'error') rep.status_ok = false;
                    if (rep.replications.length == 2) {
                        rep.sync_type = 'bi-directional';
                        if (rep.replications[1].doc._replication_state == 'error') rep.status_ok = false;
                    }
                    else rep.sync_type = rep.replications[0].doc.sync_type;
                    rep.sync_type_human = exports.sync_type_readable[rep.sync_type];
                    return rep;
                });
            return doc;
        });
        exports.cleanSyncRecords(sync_overview, callback);
    });



}

exports.cancel_garden_sync = function(sync_doc, callback) {

    console.log('cancel garden sync', sync_doc);

    // remove all the replication docs
    async.forEach(sync_doc.replications, removeReplicationDocRow, function(err){
        // remove the replication dashboard db
        drop_db(sync_doc.db_name, function(err){
            // remove the sync doc
            $.couch.db(exports.dashboard_db_name).removeDoc(sync_doc, {
               success: function() {
                    callback(null, sync_doc._id);
               },
               error : function(details) {
                   callback(new Error('Could not save sync doc'));
               }
            });


        });

    })

}


exports.initial_remote_dashboard_sync = function(remote_dashboard_db, callback) {
    exports.best_db_name('remote_dashboard', function(err, db_name){
        if (err) return callback(err);
        try {
            $.couch.replicate(remote_dashboard_db, db_name, {
                      success : function() {
                          callback(null, db_name);
                      },
                      error : function() {
                          callback(new Error('A problem replicating from remote dashboard'));
                      }
            }, {create_target : true });
        } catch(e) {
            callback(e);
        }
    });
}


exports.generate_remote_dashboard_url = function(dashboard_root_url, db_name) {
    if (!db_name) db_name = '/';
    else db_name = '/' + db_name;

    if (dashboard_root_url[dashboard_root_url.length - 1] !== '/') {
        dashboard_root_url += '/';
    }
    return dashboard_root_url + '_couch' + db_name;
}

function local_apps_by_type_mapping(local_apps) {
    var local_apps_map = {};
    _.each(local_apps, function(app){
        if (!local_apps_map[app.doc_id]) {
            local_apps_map[app.doc_id] = [];
        }
        local_apps_map[app.doc_id].push(app);
    });
    return local_apps_map;
}


function app_mapping(local_apps, remote_apps) {
    var mapping = [];

    var details = {
        needs_review : false,
        new_app_count : 0,
        sync_app_count : 0
    };



    var local_apps_by_type = local_apps_by_type_mapping(local_apps);
    console.log(local_apps_by_type);
    _.each(remote_apps, function(remote_app) {
        var local_app_options = local_apps_by_type[remote_app.doc_id];
        if (!local_app_options || local_app_options.length === 0) {
            // option to install it locally
            mapping.push({
                from: remote_app,
                install : true,
                type: 'bi-directional'
            });
            details.new_app_count++;
        } else {
            if (local_app_options.length === 1) {
                mapping.push({
                    from: remote_app,
                    to : local_app_options[0],
                    type: 'bi-directional'
                });
                details.sync_app_count++;
            } else {
                details.needs_review = true;
                details.sync_app_count++;
                var local_app =  _.first(local_app_options, function(test_app){ if (!test_app.claimed) return true; });
                if (local_app) {
                    mapping.push({
                        from: remote_app,
                        to : local_app,
                        type: 'bi-directional',
                        options: local_app_options
                    });
                    local_app.claimed = true;

                } else {
                    // all the local apps have been used up.
                    mapping.push({
                        from: remote_app,
                        type: 'bi-directional',
                        options: local_app_options
                    });
                }
            }
        }
    });
    details.mapping = _.map(mapping, function(sync, i) {
        sync.order = i;
        return sync;
    });

    return details;
}




exports.guess_initial_sync_mapping = function(dashboard_root_url, callback) {

    // replicate from remote dashboard db to a temp db locally
    // confirm to user replications about to start
    // create a sync doc
       //- url, name,
    // setup continous replication doc into the replication db from remote_dashboard to temp_db

    var remote_dashboard_db = exports.generate_remote_dashboard_url(dashboard_root_url, 'dashboard');
    var used_db_name;
    async.parallel({
        remote_apps : function(callback) {
            exports.initial_remote_dashboard_sync(remote_dashboard_db, function(err, db_name){
                used_db_name = db_name;
                exports.getInstalledApps(db_name, callback);
            });
        },
        local_apps : exports.getInstalledApps
    }, function(err, results){
        if (err) return callback(err);

        var details = app_mapping(results.local_apps, results.remote_apps);

        var sync_mapping = {
            db_name : used_db_name,
            remote_apps : results.remote_apps,
            local_apps : results.local_apps,
            dashboard_root_url: dashboard_root_url
        }

        sync_mapping = _.extend(sync_mapping, details);

        if (sync_mapping.mapping.length === 0) {
            sync_mapping.no_remote_apps = true;
        }
        callback(null, sync_mapping);
    });


}

function saveSyncMapping(mapping, callback){
    mapping.type = 'sync';
    mapping.name = mapping.dashboard_root_url;
    $.couch.db(exports.dashboard_db_name).saveDoc(mapping, {
       success: function() {
            callback(null, mapping._id);
       },
       error : function(details) {
           callback(new Error('Could not save sync doc'));
       }
    });
}

function addReplicationDoc(doc, callback) {
    $.couch.db('_replicator').saveDoc(doc, {
       success: function() {
            callback(null);
       },
       error : function(details) {
           callback(new Error('Could not save sync doc'));
       }
    });
}

function drop_db(name, callback) {
    // should check
    $.couch.db(name).drop({
        success: function(){
            callback(null);
        },
        error: function(){
            callback(new Error('cant drop db'))
        }
    })
}



function removeReplicationDocRow(doc, callback) {
    if (doc.doc) doc = doc.doc;


    $.couch.db('_replicator').removeDoc(doc, {
       success: function() {
            callback(null);
       },
       error : function(details) {
           callback(new Error('Could not remove sync doc'));
       }
    });
}



function start_replications(docs, callback) {
    async.forEachSeries(docs, function(doc, cb){
        addReplicationDoc(doc, cb);
    }, callback);
}


exports.create_sync_mapping = function(mapping, callback) {

    var root_url = url.parse( exports.generate_remote_dashboard_url(mapping.dashboard_root_url));
    root_url.auth = mapping.user + ':' + mapping.pass;

    delete mapping.pass; // before we save, delete the password

    saveSyncMapping(mapping, function(err, sync_doc_id){
        if (err) return callback(err);

        var rep_docs = [];
        _.each(mapping.mapping, function(sync_doc, index){
            if(!sync_doc.enable) return;
            var remote_db_url = url.resolve(root_url,  sync_doc.from.db);
            var local_db = sync_doc.to.db;
            var create_target = sync_doc.install;
            if (sync_doc.type == 'bi-directional' || sync_doc.type == 'pull') {
               var rep_doc = {
                   source : remote_db_url,
                   target: local_db,
                   continuous: true,
                   sync_doc : sync_doc_id,
                   sync_group : local_db,
                   sync_type: 'pull',
                   index : index,
                   "user_ctx": {
                       "name": null,
                       "roles": ["_admin"]
                   }
               }
               if (sync_doc.install) {
                   rep_doc.create_target = true;
               }
               rep_docs.push(rep_doc);
            }
            if (sync_doc.type == 'bi-directional' || sync_doc.type == 'push') {
               var rep_doc = {
                   target : remote_db_url,
                   source: local_db,
                   continuous: true,
                   sync_doc : sync_doc_id,
                   sync_group : local_db,
                   sync_type: 'push',
                   index : index,
                   "user_ctx": {
                       "name": null,
                       "roles": ["_admin"]
                   }               }
               rep_docs.push(rep_doc);
            }
        });

        // a replication for the dashboard itself
        var remote_dashboard_db = exports.generate_remote_dashboard_url(mapping.dashboard_root_url, 'dashboard');
        var rep_doc = {
            source: remote_dashboard_db,
            target : mapping.db_name,
            continuous: true,
            sync_doc : sync_doc_id,
            "user_ctx": {
                "name": null,
                "roles": ["_admin"]
            }               }
        rep_docs.push(rep_doc);


        start_replications(rep_docs, callback);
    });
}


exports.clean_unused_remote_dashboard_dbs = function(sync_docs, callback) {

    var in_use = {};
    _.each(sync_docs, function(sync_doc){
        in_use[sync_doc.db_name] = true;
    });

    $.couch.allDbs({
        success: function(data) {
            var remote_dashboard_dbs = _.filter(data, function(db_name){
                if (db_name.indexOf('remote_dashboard') === 0) return true;
            })
            async.forEach(remote_dashboard_dbs, function(remote_dashboard_db, cb){
                if (in_use[remote_dashboard_db]) return;
                drop_db(remote_dashboard_db, cb);
            },callback);

        }
    })
}

