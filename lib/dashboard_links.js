var url = require('url');

exports.dashboardURL = function(settingsDoc, dashboard_db_name, dashboard_ddoc_name, req) {
    if (settingsDoc) {
        if (settingsDoc.host_options.rootDashboard) {
            return '/';
        }

    }
    return  '/' + dashboard_db_name + '/_design/' + dashboard_ddoc_name + '/_rewrite/';
}

exports.hostRoot = function(location) {
    return location.protocol + '//' + location.host + '/';
}

exports.appUrl = function(settingsDoc, app_install_doc, req) {
    if (settingsDoc && settingsDoc.host_options.short_urls && settingsDoc.host_options.short_app_urls) {
        return '/' + app_install_doc.installed.db + '/';
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