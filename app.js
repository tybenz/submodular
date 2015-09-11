var _ = require( 'lodash' );
var P = require( 'bluebird' );
var http = require( 'http' );
var express = require( 'express' );
var bodyParser = require( 'body-parser' );
var GitHubApi = require( 'github' );

var pageSize = 30;

var github = new GitHubApi({
    version: "3.0.0",
    debug: true,
    protocol: "https",
    host: "api.github.com",
    timeout: 5000
});

github.pullRequests = P.promisifyAll( github.pullRequests );
github.issues = P.promisifyAll( github.issues );
github.repos = P.promisifyAll( github.repos );

github.authenticate({
    type: 'oauth',
    token: process.env.SUBMODULAR_TOKEN
});

var app = express();

app.use( bodyParser.urlencoded( { extended: true } ) );
app.use( bodyParser.json() );

app.post( '/pr', function( req, res, next ) {
    console.log( req.body );
    var pr = req.body.pull_request;
    var repository = req.body.repository;

    if ( !repository || !pr ) {
        console.log( 'No repo or pr in payload. Assuming it is a ping' );
        console.log( req.body );
        res.sendStatus( 200 );
        return;
    }

    if ( req.body.action != 'opened' && req.body.action != 'open' ) {
        console.log( 'Action was ' + req.body.action + '. We only act on "opened"' );
        res.sendStatus( 200 );
        return;
    }

    setTimeout( function() {
        var repoUser = repository.owner.login;
        var repoName = repository.name;
        var issueNumber = pr.number;

        var fileCount;

        var repo = {
            user: repoUser,
            repo: repoName,
            number: issueNumber
        };

        var compareUrls = [];

        var extractCompareUrls = function( data, user, repo ) {
            if ( data.html_url && data.html_url.search( /\/compare/ ) != -1 ) {
                compareUrls.push( data.html_url );
            }

            var files = data.files;

            var submodules = files.reduce( function( memo, file ) {
                var patch = file.patch;
                if ( patch.search( 'Subproject commit' ) != -1 ) {
                    memo.push({
                        name: file.filename,
                        old: patch.replace( /^[\s\S]*subproject\scommit\s([^\n]*)[\s\S]*subproject\scommit\s.*$/i, '$1' ),
                        new: patch.replace( /^[\s\S]*subproject\scommit\s[^\n]*[\s\S]*subproject\scommit\s(.*).*$/i, '$1' )
                    });
                }
                return memo;
            }, [] );

            if ( submodules.length ) {
                var newUser;
                var newRepo;

                return P.all(
                    submodules.map( function( submodule) {
                        return github.repos.getContentAsync({
                            headers: {
                                'Accept': 'application/vnd.github.VERSION.raw'
                            },
                            user: user,
                            repo: repo,
                            path: '.gitmodules'
                        })
                        .then( function( contents ) {
                            console.log( contents );
                            var index = contents.search( new RegExp( '\\[submodule "' + submodule.name + '"\\]' ) );

                            if ( index == -1 ) {
                                throw new Error( 'Could not parse .gitmodules' );
                            }

                            contents = contents.substring( index );
                            contents = contents.split( '[submodule' )[ 1 ];

                            newUser = contents.replace( /^[\s\S]*url\s\=\s(.*\@[^\:]*\:([^\/]*)|.*\:\/\/[^\/]\/([^\/]*))[\s\S]*$/, '$2' );
                            newRepo = contents.replace( /^[\s\S]*url\s\=\s(.*\@[^\:]*\:[^\/]*\/([^\.\/]*)|.*\:\/\/[^\/]\/[^\/]*\/([^\/]*))[\s\S]*$/, '$2' );
                            console.log( 'NEW USER', newUser );
                            console.log( 'NEW REPO', newRepo );

                            return github.repos.compareCommitsAsync({
                                user: newUser,
                                repo: newRepo,
                                base: submodule.old,
                                head: submodule.new
                            });
                        })
                        .then( function( data ) {
                            return extractCompareUrls( data, newUser, newRepo );
                        });
                    })
                );
            }
        };

        github.pullRequests.getAsync( repo )
        .then( function( data ) {
            fileCount = data.changed_files;
            var pageCount = Math.ceil( fileCount / pageSize );

            var filesList = [];
            for ( var i = 0; i < pageCount; i++ ) {
                var obj = _.extend( repo, { per_page: pageSize, page: i + 1 } );
                filesList.push( github.pullRequests.getFilesAsync( obj ) );
            }

            return P.all( filesList );
        })
        .then( function( files ) {
           files = Array.prototype.concat.apply( [], files );

           return extractCompareUrls( { files: files }, repoUser, repoName );
        })
        .then( function( data ) {
            return github.issues.createComment( _.extend( repo, {
                body: compareUrls.join( '\n\n' )
            }));
        })
        .then( function( data ) {
            res.send( data );
        })
        .catch( function( err ) {
            console.log( err );
            res.send( err );
        });
    }, 500 );
});

var server = http.createServer( app );

server.listen( process.env.PORT || 3333 );
