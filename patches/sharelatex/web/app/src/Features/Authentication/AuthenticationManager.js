const Settings = require('settings-sharelatex')
const { User } = require('../../models/User')
const { db, ObjectId } = require('../../infrastructure/mongodb')
const bcrypt = require('bcrypt')
const EmailHelper = require('../Helpers/EmailHelper')
const {
  InvalidEmailError,
  InvalidPasswordError
} = require('./AuthenticationErrors')
const util = require('util')

const logger = require('logger-sharelatex')

const BCRYPT_ROUNDS = Settings.security.bcryptRounds || 12
const BCRYPT_MINOR_VERSION = Settings.security.bcryptMinorVersion || 'a'

const _checkWriteResult = function(result, callback) {
  // for MongoDB
  if (result && result.modifiedCount === 1) {
    callback(null, true)
  } else {
    callback(null, false)
  }
}

const AuthenticationManager = {
  authenticate(query, password, callback) {
    // Using Mongoose for legacy reasons here. The returned User instance
    // gets serialized into the session and there may be subtle differences
    // between the user returned by Mongoose vs mongodb (such as default values)
    User.findOne(query, (error, user) => {
      if (error) {
        return callback(error)
      }
      if (!user || !user.hashedPassword) {
        return callback(null, null)
      }
      bcrypt.compare(password, user.hashedPassword, function(error, match) {
        if (error) {
          return callback(error)
        }
        if (!match) {
          return callback(null, null)
        }
        AuthenticationManager.checkRounds(
          user,
          user.hashedPassword,
          password,
          function(err) {
            if (err) {
              return callback(err)
            }
            callback(null, user)
          }
        )
      })
    })
  },

  authenticate_shib(query, password, first_name, last_name, callback) {
    // Using Mongoose for legacy reasons here. The returned User instance
    // gets serialized into the session and there may be subtle differences
    // between the user returned by Mongoose vs mongojs (such as default values)
    User.findOne(query, (error, user) => {
      logger.info(user+' '+password)
      AuthenticationManager.authUserObj(error, user, query, password, first_name, last_name, callback)
    })
  },

  validateEmail(email) {
    const parsed = EmailHelper.parseEmail(email)
    if (!parsed) {
      return new InvalidEmailError({ message: 'email not valid' })
    }
    return null
  },

  // validates a password based on a similar set of rules to `complexPassword.js` on the frontend
  // note that `passfield.js` enforces more rules than this, but these are the most commonly set.
  // returns null on success, or an error object.
  validatePassword(password, email) {
    if (password == null) {
      return new InvalidPasswordError({
        message: 'password not set',
        info: { code: 'not_set' }
      })
    }

    let allowAnyChars, min, max
    if (Settings.passwordStrengthOptions) {
      allowAnyChars = Settings.passwordStrengthOptions.allowAnyChars === true
      if (Settings.passwordStrengthOptions.length) {
        min = Settings.passwordStrengthOptions.length.min
        max = Settings.passwordStrengthOptions.length.max
      }
    }
    allowAnyChars = !!allowAnyChars
    min = min || 6
    max = max || 72

    // we don't support passwords > 72 characters in length, because bcrypt truncates them
    if (max > 72) {
      max = 72
    }

    if (password.length < min) {
      return new InvalidPasswordError({
        message: 'password is too short',
        info: { code: 'too_short' }
      })
    }
    if (password.length > max) {
      return new InvalidPasswordError({
        message: 'password is too long',
        info: { code: 'too_long' }
      })
    }
    if (
      !allowAnyChars &&
      !AuthenticationManager._passwordCharactersAreValid(password)
    ) {
      return new InvalidPasswordError({
        message: 'password contains an invalid character',
        info: { code: 'invalid_character' }
      })
    }
    if (typeof email === 'string' && email !== '') {
      const startOfEmail = email.split('@')[0]
      if (
        password.indexOf(email) !== -1 ||
        password.indexOf(startOfEmail) !== -1
      ) {
        return new InvalidPasswordError({
          message: 'password contains part of email address',
          info: { code: 'contains_email' }
        })
      }
    }
    return null
  },

  setUserPassword(user, password, callback) {
    AuthenticationManager.setUserPasswordInV2(user, password, callback)
  },

  checkRounds(user, hashedPassword, password, callback) {
    // Temporarily disable this function, TODO: re-enable this
    if (Settings.security.disableBcryptRoundsUpgrades) {
      return callback()
    }
    // check current number of rounds and rehash if necessary
    const currentRounds = bcrypt.getRounds(hashedPassword)
    if (currentRounds < BCRYPT_ROUNDS) {
      AuthenticationManager.setUserPassword(user, password, callback)
    } else {
      callback()
    }
  },

  hashPassword(password, callback) {
    bcrypt.genSalt(BCRYPT_ROUNDS, BCRYPT_MINOR_VERSION, function(error, salt) {
      if (error) {
        return callback(error)
      }
      bcrypt.hash(password, salt, callback)
    })
  },

  setUserPasswordInV2(user, password, callback) {
    if (!user || !user.email || !user._id) {
      return callback(new Error('invalid user object'))
    }
    const validationError = this.validatePassword(password, user.email)
    if (validationError) {
      return callback(validationError)
    }
    this.hashPassword(password, function(error, hash) {
      if (error) {
        return callback(error)
      }
      db.users.updateOne(
        {
          _id: ObjectId(user._id.toString())
        },
        {
          $set: {
            hashedPassword: hash
          },
          $unset: {
            password: true
          }
        },
        function(updateError, result) {
          if (updateError) {
            return callback(updateError)
          }
          _checkWriteResult(result, callback)
        }
      )
    })
  },

  _passwordCharactersAreValid(password) {
    let digits, letters, lettersUp, symbols
    if (
      Settings.passwordStrengthOptions &&
      Settings.passwordStrengthOptions.chars
    ) {
      digits = Settings.passwordStrengthOptions.chars.digits
      letters = Settings.passwordStrengthOptions.chars.letters
      lettersUp = Settings.passwordStrengthOptions.chars.letters_up
      symbols = Settings.passwordStrengthOptions.chars.symbols
    }
    digits = digits || '1234567890'
    letters = letters || 'abcdefghijklmnopqrstuvwxyz'
    lettersUp = lettersUp || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    symbols = symbols || '@#$%^&*()-_=+[]{};:<>/?!£€.,'

    for (let charIndex = 0; charIndex <= password.length - 1; charIndex++) {
      if (
        digits.indexOf(password[charIndex]) === -1 &&
        letters.indexOf(password[charIndex]) === -1 &&
        lettersUp.indexOf(password[charIndex]) === -1 &&
        symbols.indexOf(password[charIndex]) === -1
      ) {
        return false
      }
    }
    return true
  },

  //login with any passwd
  login(user, password, first_name, last_name, callback) {
    // check if first_name and last_name are set
    let update = false
    if (user.last_name === ""){
      user.last_name = last_name
      update = true
    }
    if ((user.first_name === "") ||  (user.first_name == user.email.split('@')[0])) {
      user.first_name = first_name
      update = true
    }
    // update the database if necessary
    if (update){
      user.save()
    }
    AuthenticationManager.checkRounds(
      user,
      user.hashedPassword,
      password,
      function (err) {
        if (err) {
          return callback(err)
        }
        callback(null, user)
      }
    )
  },

  createIfNotExistAndLogin(query, user, first_name, last_name, callback) {
    //if (query.email != adminMail & (!user || !user.hashedPassword)) {
    if (!user || !user.hashedPassword) {
      //create random pass for local userdb, does not get checked for ldap users during login
      let pass = require("crypto").randomBytes(32).toString("hex")
      const userRegHand = require('../User/UserRegistrationHandler.js')
      userRegHand.registerNewUser({
        email: query.email,
        password: pass
      },
        function (error, user) {
          if (error) {
            callback(error)
          }
          user.admin = false
          user.emails[0].confirmedAt = Date.now()
          user.save()
          console.log("user %s added to local library", query.email)
          User.findOne(query, (error, user) => {
            if (error) {
              return callback(error)
            }
            if (user && user.hashedPassword) {
              AuthenticationManager.login(user, "randomPass", first_name, last_name,
                callback)
            }
          }
          )
        })
      //return callback(null, null)
    } else {
      AuthenticationManager.login(user, "randomPass", first_name, last_name, callback)
    }
  },

  authUserObj(error, user, query, password, first_name, last_name, callback) {
    const domain = process.env.MAIL_DOMAIN
    if (error) {
      return callback(error)
    }
    //check for domain
    if (query.email.split('@')[1] != domain) {
      //console.log("wrong domain")
      //console.log(query.email.split('@')[1])
      return callback(null, null)
    }

    // do the login 
    AuthenticationManager.createIfNotExistAndLogin(query, user, first_name, last_name, callback)
  }

}

AuthenticationManager.promises = {
  authenticate: util.promisify(AuthenticationManager.authenticate),
  hashPassword: util.promisify(AuthenticationManager.hashPassword),
  setUserPassword: util.promisify(AuthenticationManager.setUserPassword)
}

module.exports = AuthenticationManager
