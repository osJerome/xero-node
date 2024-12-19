require("dotenv").config();

import cors from "cors";
import express from "express";
import jwtDecode from "jwt-decode";

import { Request, Response, CookieOptions } from "express";
import { TokenSet } from "openid-client";
import {
  XeroAccessToken,
  XeroIdToken,
  XeroClient,
  Contact,
  LineItem,
  Invoice,
  Invoices,
  Phone,
  Contacts,
} from "xero-node";

const session = require("express-session");

const client_id: string = process.env.CLIENT_ID;
const client_secret: string = process.env.CLIENT_SECRET;
const redirectUrl: string = process.env.REDIRECT_URI;
const scopes: string =
  "openid profile email accounting.settings accounting.reports.read accounting.journals.read accounting.contacts accounting.attachments accounting.transactions offline_access";

const xero = new XeroClient({
  clientId: client_id,
  clientSecret: client_secret,
  redirectUris: [redirectUrl],
  scopes: scopes.split(" "),
});

if (!client_id || !client_secret || !redirectUrl) {
  throw Error(
    "Environment Variables not all set - please check your .env file in the project root or create one!"
  );
}

const app: express.Application = express();

// Configure CORS middleware
app.use(
  cors({
    origin: ["http://localhost:5173"], // Frontend URL
    methods: ["GET", "POST"], // Allowed HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers
    credentials: true, // Important for handling sessions
  })
);

app.use(express.static(__dirname + "/build"));

app.use(
  session({
    secret: "something crazy",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false },
  })
);

const COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000,
};

const authenticationData: any = (req: Request, res: Response) => {
  return {
    decodedIdToken: req.session.decodedIdToken,
    decodedAccessToken: req.session.decodedAccessToken,
    tokenSet: req.session.tokenSet,
    allTenants: req.session.allTenants,
    activeTenant: req.session.activeTenant,
  };
};

app.get("/", (req: Request, res: Response) => {
  res.send(`<a href='/connect'>Connect to Xero</a>`);
});

app.get("/connect", async (req: Request, res: Response) => {
  try {
    const consentUrl: string = await xero.buildConsentUrl();
    res.redirect(consentUrl);
  } catch (err) {
    res.send("Sorry, something went wrong");
  }
});

app.get("/callback", async (req: Request, res: Response) => {
  try {
    const tokenSet: TokenSet = await xero.apiCallback(req.url);
    await xero.updateTenants();

    const decodedIdToken: XeroIdToken = jwtDecode(tokenSet.id_token);
    const decodedAccessToken: XeroAccessToken = jwtDecode(
      tokenSet.access_token
    );

    req.session.decodedIdToken = decodedIdToken;
    req.session.decodedAccessToken = decodedAccessToken;
    req.session.tokenSet = tokenSet;
    req.session.allTenants = xero.tenants;

    // XeroClient is sorting tenants behind the scenes so that most recent / active connection is at index 0
    req.session.activeTenant = xero.tenants[0];

    const authData: any = authenticationData(req, res);
    console.log(authData);

    // Store tokens into cookie
    res.cookie("xero_access_token", tokenSet.access_token, COOKIE_OPTIONS);
    res.cookie(
      "xero_user_id",
      authData.decodedAccessToken.xero_userid,
      COOKIE_OPTIONS
    );
    res.cookie("xero_refresh_token", tokenSet.refresh_token, COOKIE_OPTIONS);

    res.redirect("http://localhost:5173");
  } catch (err) {
    res.send("Sorry, something went wrong");
  }
});

app.get("/auth-status", async (req: Request, res: Response) => {
  try {
    if (!req.session.tokenSet) {
      return res.json({ isAuthenticated: false });
    }

    const expiresAt = req.session.tokenSet.expires_at;
    const isExpired = expiresAt ? Date.now() >= expiresAt * 1000 : true;

    // If token is expired but we have a refresh token, try to refresh
    if (isExpired && req.session.tokenSet.refresh_token) {
      try {
        const newTokenSet = await xero.refreshToken();
        req.session.tokenSet = newTokenSet;

        return res.json({
          isAuthenticated: true,
          tenantId: req.session.activeTenant?.tenantId,
        });
      } catch (refreshError) {
        console.error("Error refreshing token:", refreshError);
        return res.json({ isAuthenticated: false });
      }
    }

    res.json({
      isAuthenticated: !isExpired,
      tenantId: req.session.activeTenant?.tenantId,
    });
  } catch (err) {
    console.error("Error checking auth status:", err);
    res.json({ isAuthenticated: false });
  }
});

app.get("/organisation", async (req: Request, res: Response) => {
  try {
    const tokenSet: TokenSet = await xero.readTokenSet();
    console.log(tokenSet.expired() ? "expired" : "valid");
    const response: any = await xero.accountingApi.getOrganisations(
      req.session.activeTenant.tenantId
    );
    res.send(`Hello, ${response.body.organisations[0].name}`);
  } catch (err) {
    res.send("Sorry, something went wrong");
  }
});

app.get("/invoice", async (req: Request, res: Response) => {
  try {
    const contacts = await xero.accountingApi.getContacts(
      req.session.activeTenant.tenantId
    );
    console.log("contacts: ", contacts.body.contacts);
    const where = 'Status=="ACTIVE" AND Type=="SALES"';
    const accounts = await xero.accountingApi.getAccounts(
      req.session.activeTenant.tenantId,
      null,
      where
    );
    console.log("accounts: ", accounts.body.accounts);
    const contact: Contact = {
      contactID: contacts.body.contacts[0].contactID,
    };
    const lineItem: LineItem = {
      accountID: accounts.body.accounts[0].accountID,
      description: "consulting",
      quantity: 1.0,
      unitAmount: 10.0,
    };
    const invoice: Invoice = {
      lineItems: [lineItem],
      contact: contact,
      dueDate: "2021-09-25",
      date: "2021-09-24",
      type: Invoice.TypeEnum.ACCREC,
    };
    const invoices: Invoices = {
      invoices: [invoice],
    };
    const response = await xero.accountingApi.createInvoices(
      req.session.activeTenant.tenantId,
      invoices
    );
    console.log("invoices: ", response.body.invoices);
    res.json(response.body.invoices);
  } catch (err) {
    res.json(err);
  }
});

app.get("/contact", async (req: Request, res: Response) => {
  try {
    const contact: Contact = {
      name: "Bruce Banner",
      emailAddress: "hulk@avengers.com",
      phones: [
        {
          phoneNumber: "555-555-5555",
          phoneType: Phone.PhoneTypeEnum.MOBILE,
        },
      ],
    };
    const contacts: Contacts = {
      contacts: [contact],
    };
    const response = await xero.accountingApi.createContacts(
      req.session.activeTenant.tenantId,
      contacts
    );
    console.log("contacts: ", response.body.contacts);
    res.json(response.body.contacts);
  } catch (err) {
    res.json(err);
  }
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`App running on http://localhost:${PORT}`);
});
