const AuthenticationManager = require('./AuthenticationManager')
const OError = require('@overleaf/o-error')
const LoginRateLimiter = require('../Security/LoginRateLimiter')
const UserUpdater = require('../User/UserUpdater')
const Metrics = require('@overleaf/metrics')
const logger = require('logger-sharelatex')
const querystring = require('querystring')
const Settings = require('settings-sharelatex')
const basicAuth = require('basic-auth-connect')
const crypto = require('crypto')
const UserHandler = require('../User/UserHandler')
const UserSessionsManager = require('../User/UserSessionsManager')
const SessionStoreManager = require('../../infrastructure/SessionStoreManager')
const Analytics = require('../Analytics/AnalyticsManager')
const passport = require('passport')
const NotificationsBuilder = require('../Notifications/NotificationsBuilder')
const UrlHelper = require('../Helpers/UrlHelper')
const AsyncFormHelper = require('../Helpers/AsyncFormHelper')
const _ = require('lodash')
const UserAuditLogHandler = require('../User/UserAuditLogHandler')
const {
  acceptsJson
} = require('../../infrastructure/RequestContentTypeDetection')


function send401WithChallenge(res) {
  res.setHeader('WWW-Authenticate', 'OverleafLogin')
  res.sendStatus(401)
}

const AuthenticationController = {
  serializeUser(user, callback) {
    if (!user._id || !user.email) {
      const err = new Error('serializeUser called with non-user object')
      logger.warn({ user }, err.message)
      return callback(err)
    }
    const lightUser = {
      _id: user._id,
      first_name: user.first_name,
      last_name: user.last_name,
      isAdmin: user.isAdmin,
      staffAccess: user.staffAccess,
      email: user.email,
      referal_id: user.referal_id,
      session_created: new Date().toISOString(),
      ip_address: user._login_req_ip,
      must_reconfirm: user.must_reconfirm,
      v1_id: user.overleaf != null ? user.overleaf.id : undefined
    }
    callback(null, lightUser)
  },

  deserializeUser(user, cb) {
    cb(null, user)
  },

  passportLogin(req, res, next) {
    // This function is middleware which wraps the passport.authenticate middleware,
    // so we can send back our custom `{message: {text: "", type: ""}}` responses on failure,
    // and send a `{redir: ""}` response on success
    passport.authenticate('local', function(err, user, info) {
      logger.info('post-password-auth:', err)
      if (err) {
        return next(err)
      }
      if (user) {
        // `user` is either a user object or false
        return AuthenticationController.finishLogin(user, req, res, next)
      } else {
        if (info.redir != null) {
          return res.json({ redir: info.redir })
        } else {
          return res.json({ message: info })
        }
      }
    })(req, res, next)
  },

  finishLogin(user, req, res, next) {
    if (user === false) {
      return res.redirect('/login')
    } // OAuth2 'state' mismatch

    const Modules = require('../../infrastructure/Modules')
    Modules.hooks.fire('preFinishLogin', req, res, user, function(
      error,
      results
    ) {
      if (error) {
        return next(error)
      }
      if (results.some(result => result && result.doNotFinish)) {
        return
      }

      if (user.must_reconfirm) {
        return AuthenticationController._redirectToReconfirmPage(req, res, user)
      }

      const redir =
        AuthenticationController._getRedirectFromSession(req) || '/project'
      _loginAsyncHandlers(req, user)
      const userId = user._id
      UserAuditLogHandler.addEntry(userId, 'login', userId, req.ip, err => {
        if (err) {
          return next(err)
        }
        _afterLoginSessionSetup(req, user, function(err) {
          if (err) {
            return next(err)
          }
          AuthenticationController._clearRedirectFromSession(req)
          AsyncFormHelper.redirect(req, res, redir)
        })
      })
    })
  },

  doPassportLogin(req, username, password, done) {
    const email = username.toLowerCase()
    const Modules = require('../../infrastructure/Modules')
    Modules.hooks.fire('preDoPassportLogin', req, email, function(
      err,
      infoList
    ) {
      if (err) {
        return done(err)
      }
      const info = infoList.find(i => i != null)
      if (info != null) {
        return done(null, false, info)
      }
      LoginRateLimiter.processLoginRequest(email, function(err, isAllowed) {
        if (err) {
          return done(err)
        }
        if (!isAllowed) {
          logger.log({ email }, 'too many login requests')
          return done(null, null, {
            text: req.i18n.translate('to_many_login_requests_2_mins'),
            type: 'error'
          })
        }
        AuthenticationManager.authenticate({ email }, password, function(
          error,
          user
        ) {
          if (error != null) {
            return done(error)
          }
          if (user != null) {
            // async actions
            done(null, user)
          } else {
            AuthenticationController._recordFailedLogin()
            logger.log({ email }, 'failed log in')
            done(null, false, {
              text: req.i18n.translate('email_or_password_wrong_try_again'),
              type: 'error'
            })
          }
        })
      })
    })
  },

  ipMatchCheck(req, user) {
    if (req.ip !== user.lastLoginIp) {
      NotificationsBuilder.ipMatcherAffiliation(user._id).create(req.ip)
    }
    return UserUpdater.updateUser(user._id.toString(), {
      $set: { lastLoginIp: req.ip }
    })
  },

  setInSessionUser(req, props) {
    const sessionUser = AuthenticationController.getSessionUser(req)
    if (!sessionUser) {
      return
    }
    for (let key in props) {
      const value = props[key]
      sessionUser[key] = value
    }
    return null
  },

  shibbolethAuth(req, res, next) {
    logger.info("checking for shibboleth authorization")

    const domain = process.env.MAIL_DOMAIN
    const password = '123456789'
    if (process.env.REMOTE_USER != null) {
      logger.log('remote-user defined')
      remote_user = process.env.REMOTE_USER
    }
    else
    {
      logger.log('remote-user undefined')
      remote_user = 'REMOTE_USER'
    }
    const username = req.headers[remote_user]

    if (username == null){
      logger.warn(('Unknown username; shibboleth configuration problem!'))
      return res.redirect('/')
    }

    const email = username + '@' + domain

    logger.log('username='+email)

    // extract the first/last name from header
    if (process.env.REMOTE_LASTNAME != null){
      last_name = req.headers[process.env.REMOTE_LASTNAME]
    }
    else
    {
      last_name = undefined
    }
    if (process.env.REMOTE_FIRSTNAME != null) {
      first_name = req.headers[process.env.REMOTE_FIRSTNAME]
    }
    else {
      first_name = undefined
    }

    // use the special authenticte function
    // unknown users will be created automatically
    AuthenticationManager.authenticate_shib({ email }, password, first_name, last_name, function (
      error,
      user
    ) {
      if (error != null) {
      }
      if (user != null) {
        // async actions
        logger.log({email}, 'successfully logged in')
        return AuthenticationController.finishLogin(user, req, res, next)
      } else {
        logger.log({ email }, 'failed log in')
      }
      return res.redirect('/')
    })
  },

  isUserLoggedIn(req) {
    const userId = AuthenticationController.getLoggedInUserId(req)
    return ![null, undefined, false].includes(userId)
  },

  // TODO: perhaps should produce an error if the current user is not present
  getLoggedInUserId(req) {
    const user = AuthenticationController.getSessionUser(req)
    if (user) {
      return user._id
    } else {
      return null
    }
  },

  getLoggedInUserV1Id(req) {
    const user = AuthenticationController.getSessionUser(req)
    if ((user != null ? user.v1_id : undefined) != null) {
      return user.v1_id
    } else {
      return null
    }
  },

  getSessionUser(req) {
    const sessionUser = _.get(req, ['session', 'user'])
    const sessionPassportUser = _.get(req, ['session', 'passport', 'user'])
    return sessionUser || sessionPassportUser || null
  },

  requireLogin() {
    const doRequest = function(req, res, next) {
      if (next == null) {
        next = function() {}
      }
      if (!AuthenticationController.isUserLoggedIn(req)) {
        if (acceptsJson(req)) return send401WithChallenge(res)
        return AuthenticationController._redirectToLoginOrRegisterPage(req, res)
      } else {
        req.user = AuthenticationController.getSessionUser(req)
        return next()
      }
    }

    return doRequest
  },

  requireOauth() {
    // require this here because module may not be included in some versions
    const Oauth2Server = require('../../../../modules/oauth2-server/app/src/Oauth2Server')
    return function(req, res, next) {
      if (next == null) {
        next = function() {}
      }
      const request = new Oauth2Server.Request(req)
      const response = new Oauth2Server.Response(res)
      return Oauth2Server.server.authenticate(request, response, {}, function(
        err,
        token
      ) {
        if (err) {
          // use a 401 status code for malformed header for git-bridge
          if (
            err.code === 400 &&
            err.message === 'Invalid request: malformed authorization header'
          ) {
            err.code = 401
          }
          // send all other errors
          return res
            .status(err.code)
            .json({ error: err.name, error_description: err.message })
        }
        req.oauth = { access_token: token.accessToken }
        req.oauth_token = token
        req.oauth_user = token.user
        return next()
      })
    }
  },

  validateUserSession: function() {
    // Middleware to check that the user's session is still good on key actions,
    // such as opening a a project. Could be used to check that session has not
    // exceeded a maximum lifetime (req.session.session_created), or for session
    // hijacking checks (e.g. change of ip address, req.session.ip_address). For
    // now, just check that the session has been loaded from the session store
    // correctly.
    return function(req, res, next) {
      // check that the session store is returning valid results
      if (req.session && !SessionStoreManager.hasValidationToken(req)) {
        // force user to update session
        req.session.regenerate(() => {
          // need to destroy the existing session and generate a new one
          // otherwise they will already be logged in when they are redirected
          // to the login page
          if (acceptsJson(req)) return send401WithChallenge(res)
          AuthenticationController._redirectToLoginOrRegisterPage(req, res)
        })
      } else {
        next()
      }
    }
  },

  _globalLoginWhitelist: [],
  addEndpointToLoginWhitelist(endpoint) {
    return AuthenticationController._globalLoginWhitelist.push(endpoint)
  },

  requireGlobalLogin(req, res, next) {
    if (
      AuthenticationController._globalLoginWhitelist.includes(
        req._parsedUrl.pathname
      )
    ) {
      return next()
    }

    //logger.log('request res=')
    //logger.log(req.headers)

    if (req.headers.authorization != null) {
      AuthenticationController.httpAuth(req, res, next)
    } else if (AuthenticationController.isUserLoggedIn(req)) {
      next()
    } else {
      logger.log(
        { url: req.url },
        'user trying to access endpoint not in global whitelist'
      )
      if (acceptsJson(req)) return send401WithChallenge(res)
      AuthenticationController.setRedirectInSession(req)
      res.redirect('/login')
    }
  },

  validateAdmin(req, res, next) {
    const adminDomains = Settings.adminDomains
    if (
      !adminDomains ||
      !(Array.isArray(adminDomains) && adminDomains.length)
    ) {
      return next()
    }
    const user = AuthenticationController.getSessionUser(req)
    if (!(user && user.isAdmin)) {
      return next()
    }
    const email = user.email
    if (email == null) {
      return next(
        new OError('[ValidateAdmin] Admin user without email address', {
          userId: user._id
        })
      )
    }
    if (!adminDomains.find(domain => email.endsWith(`@${domain}`))) {
      return next(
        new OError('[ValidateAdmin] Admin user with invalid email domain', {
          email: email,
          userId: user._id
        })
      )
    }
    return next()
  },

  httpAuth: basicAuth(function(user, pass) {
    let expectedPassword = Settings.httpAuthUsers[user]
    const isValid =
      expectedPassword &&
      expectedPassword.length === pass.length &&
      crypto.timingSafeEqual(Buffer.from(expectedPassword), Buffer.from(pass))
    if (!isValid) {
      logger.err({ user, pass }, 'invalid login details')
    }
    return isValid
  }),

  setRedirectInSession(req, value) {
    if (value == null) {
      value =
        Object.keys(req.query).length > 0
          ? `${req.path}?${querystring.stringify(req.query)}`
          : `${req.path}`
    }
    if (
      req.session != null &&
      !/^\/(socket.io|js|stylesheets|img)\/.*$/.test(value) &&
      !/^.*\.(png|jpeg|svg)$/.test(value)
    ) {
      const safePath = UrlHelper.getSafeRedirectPath(value)
      return (req.session.postLoginRedirect = safePath)
    }
  },

  _redirectToLoginOrRegisterPage(req, res) {
    if (
      req.query.zipUrl != null ||
      req.query.project_name != null ||
      req.path === '/user/subscription/new'
    ) {
      AuthenticationController._redirectToRegisterPage(req, res)
    } else {
      AuthenticationController._redirectToLoginPage(req, res)
    }
  },

  _redirectToLoginPage(req, res) {
    logger.log(
      { url: req.url },
      'user not logged in so redirecting to login page'
    )
    AuthenticationController.setRedirectInSession(req)
    const url = `/login?${querystring.stringify(req.query)}`
    res.redirect(url)
    Metrics.inc('security.login-redirect')
  },

  _redirectToReconfirmPage(req, res, user) {
    logger.log(
      { url: req.url },
      'user needs to reconfirm so redirecting to reconfirm page'
    )
    req.session.reconfirm_email = user != null ? user.email : undefined
    const redir = '/user/reconfirm'
    AsyncFormHelper.redirect(req, res, redir)
  },

  _redirectToRegisterPage(req, res) {
    logger.log(
      { url: req.url },
      'user not logged in so redirecting to register page'
    )
    AuthenticationController.setRedirectInSession(req)
    const url = `/register?${querystring.stringify(req.query)}`
    res.redirect(url)
    Metrics.inc('security.login-redirect')
  },

  _recordSuccessfulLogin(userId, callback) {
    if (callback == null) {
      callback = function() {}
    }
    UserUpdater.updateUser(
      userId.toString(),
      {
        $set: { lastLoggedIn: new Date() },
        $inc: { loginCount: 1 }
      },
      function(error) {
        if (error != null) {
          callback(error)
        }
        Metrics.inc('user.login.success')
        callback()
      }
    )
  },

  _recordFailedLogin(callback) {
    Metrics.inc('user.login.failed')
    if (callback) callback()
  },

  _getRedirectFromSession(req) {
    let safePath
    const value = _.get(req, ['session', 'postLoginRedirect'])
    if (value) {
      safePath = UrlHelper.getSafeRedirectPath(value)
    }
    return safePath || null
  },

  _clearRedirectFromSession(req) {
    if (req.session != null) {
      delete req.session.postLoginRedirect
    }
  }
}

function _afterLoginSessionSetup(req, user, callback) {
  if (callback == null) {
    callback = function() {}
  }
  req.login(user, function(err) {
    if (err) {
      OError.tag(err, 'error from req.login', {
        user_id: user._id
      })
      return callback(err)
    }
    // Regenerate the session to get a new sessionID (cookie value) to
    // protect against session fixation attacks
    const oldSession = req.session
    req.session.destroy(function(err) {
      if (err) {
        OError.tag(err, 'error when trying to destroy old session', {
          user_id: user._id
        })
        return callback(err)
      }
      req.sessionStore.generate(req)
      // Note: the validation token is not writable, so it does not get
      // transferred to the new session below.
      for (let key in oldSession) {
        const value = oldSession[key]
        if (key !== '__tmp' && key !== 'csrfSecret') {
          req.session[key] = value
        }
      }
      req.session.save(function(err) {
        if (err) {
          OError.tag(err, 'error saving regenerated session after login', {
            user_id: user._id
          })
          return callback(err)
        }
        UserSessionsManager.trackSession(user, req.sessionID, function() {})
        callback(null)
      })
    })
  })
}
function _loginAsyncHandlers(req, user) {
  UserHandler.setupLoginData(user, err => {
    if (err != null) {
      logger.warn({ err }, 'error setting up login data')
    }
  })
  LoginRateLimiter.recordSuccessfulLogin(user.email)
  AuthenticationController._recordSuccessfulLogin(user._id)
  AuthenticationController.ipMatchCheck(req, user)
  Analytics.recordEvent(user._id, 'user-logged-in')
  Analytics.identifyUser(user._id, req.sessionID)
  logger.log(
    { email: user.email, user_id: user._id.toString() },
    'successful log in'
  )
  req.session.justLoggedIn = true
  // capture the request ip for use when creating the session
  return (user._login_req_ip = req.ip)
}

module.exports = AuthenticationController
