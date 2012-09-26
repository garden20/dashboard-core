var url = require('url');
var _ = require('underscore')._;

exports.dashboardURL = function(settingsDoc, dashboard_db_name, dashboard_ddoc_name, req) {
    if (settingsDoc) {
        if (settingsDoc.host_options.rootDashboard) {
            // only if the current host matches one of the specified hosts
            var use_short = false;
            var host = req.headers.Host;
            var hostnames = settingsDoc.host_options.hostnames.split(',');
            _.each(hostnames, function(hostname){
                var p = url.parse(hostname);
                var to_bind = p.hostname;
                if (p.port != '80' && (_.isString(p.port) || _.isNumber(p.port)) ) {
                    to_bind += ':' + p.port;
                }
                if (to_bind == host) use_short = true;
            });
            if (use_short) return '/';
        }
    }
    return  '/' + dashboard_db_name + '/_design/' + dashboard_ddoc_name + '/_rewrite/';
}

exports.hostRoot = function(location) {
    return location.protocol + '//' + location.host + '/';
}

exports.appUrl = function(settingsDoc, app_install_doc, req) {
    try {
        if (app_install_doc.kanso.config.legacy_mode) {
            return '/' + app_install_doc.installed.db + '/_design/' + app_install_doc.doc_id  + app_install_doc.open_path;
        }
    } catch(ignore){}

    if (settingsDoc && settingsDoc.host_options.short_urls && settingsDoc.host_options.short_app_urls) {

        // only if the current host matches one of the specified hosts
        var use_short = false;
        var host = req.headers.Host;
        var hostnames = settingsDoc.host_options.hostnames.split(',');
        _.each(hostnames, function(hostname){
            var p = url.parse(hostname);
            var to_bind = p.hostname;
            if (p.port != '80' && (_.isString(p.port) || _.isNumber(p.port)) ) {
                to_bind += ':' + p.port;
            }
            if (to_bind == host) use_short = true;
        });
        if (use_short) return '/' + app_install_doc.installed.db + '/';

    }

    return '/' + app_install_doc.installed.db + '/_design/' + app_install_doc.doc_id  + app_install_doc.open_path;
}

exports.appSettingsUrl = function(settingsDoc, app_install_doc) {
    if (settingsDoc.host_options.rootDashboard) {
        return '/settings#/apps/' + app_install_doc._id;
    }

    return '/dashboard/_design/dashboard/_rewrite/settings#/apps/' + app_install_doc._id;
}

exports.friendlyName = function(dashboard_url) {
    var details = url.parse(dashboard_url);
    if (details.hostname === '0.0.0.0' || details.hostname === '127.0.0.1' || details.hostname === 'localhost') {
        return 'Your Computer';
    }
    return details.hostname;
}