import { Request, Response } from "express";
import util from "util";
import Booking from "../infrastructure/schemas/Booking";
import stripe from "../infrastructure/stripe";
import Hotel from "../infrastructure/schemas/Hotel";

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;
const FRONTEND_URL = process.env.FRONTEND_URL as string;

async function fulfillCheckout(sessionId: string) {
  console.log("Fulfilling Checkout Session " + sessionId);

  // ✅ Make this function safe to run multiple times (idempotent)
  const existingBooking = await Booking.findOne({
    'stripeSessionId': sessionId,
  });
  if (existingBooking && existingBooking.paymentStatus === 'PAID') {
    console.log(`Session ${sessionId} already fulfilled`);
    return;
  }

  const checkoutSession = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["line_items"],
  });
  console.log(
    util.inspect(checkoutSession, false, null, true /* enable colors */)
  );

  const booking = await Booking.findById(checkoutSession.metadata?.bookingId);
  if (!booking) {
    throw new Error("Booking not found");
  }

  // ✅ Ensure fulfillment hasn't already happened
  if (booking.paymentStatus !== "PENDING") {
    console.log(`Booking ${booking._id} already processed`);
    return;
  }

  // ✅ Fulfillment logic (marking booking as PAID)
  if (checkoutSession.payment_status !== "unpaid") {
    await Booking.findByIdAndUpdate(booking._id, {
      paymentStatus: "PAID",
      stripeSessionId: sessionId, // ✅ Save Stripe session ID for future reference
    });
    console.log(`Booking ${booking._id} marked as PAID`);
  }
}

export const handleWebhook = async (req: Request, res: Response) => {
  const payload = req.body;
  const sig = req.headers["stripe-signature"] as string;

  let event;

  try {
    event = stripe.webhooks.constructEvent(payload, sig, endpointSecret);
    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      await fulfillCheckout(event.data.object.id);

      res.status(200).send();
      return;
    }
  } catch (err) {
    // @ts-ignore
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }
};

export const createCheckoutSession = async (req: Request, res: Response) => {
  try {
    const bookingId = req.body.bookingId;
    console.log("body", req.body);
    const booking = await Booking.findById(bookingId);

    if (!booking) {
      throw new Error("Booking not found");
    }

    // Find the hotel separately
    const hotel = await Hotel.findById(booking.hotelId);
    if (!hotel) {
      throw new Error("Hotel not found");
    }

    // Calculate number of nights
    const checkIn = new Date(booking.checkIn);
    const checkOut = new Date(booking.checkOut);
    const numberOfNights = Math.ceil((checkOut.getTime() - checkIn.getTime()) / (1000 * 60 * 60 * 24));

    if (!hotel.stripePriceId) {
      throw new Error("Stripe price ID is missing for this hotel");
    }

    const session = await stripe.checkout.sessions.create({
      ui_mode: "embedded",
      line_items: [{
        price: hotel.stripePriceId,
        quantity: numberOfNights,
      }],
      mode: "payment",
      return_url: `${FRONTEND_URL}/booking/complete?session_id={CHECKOUT_SESSION_ID}`,
      metadata: {
        bookingId: req.body.bookingId,
      },
    });

    res.send({ clientSecret: session.client_secret });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).json({ 
      message: "Failed to create checkout session", 
      error: error instanceof Error ? error.message : String(error) 
    });
  }
};

export const retrieveSessionStatus = async (req: Request, res: Response) => {
  const checkoutSession = await stripe.checkout.sessions.retrieve(
    req.query.session_id as string
  );

  const booking = await Booking.findById(checkoutSession.metadata?.bookingId);
  if (!booking) {
    throw new Error("Booking not found");
  }
  const hotel = await Hotel.findById(booking.hotelId);
  if (!hotel) {
    throw new Error("Hotel not found");
  }

  res.status(200).json({
    bookingId: booking._id,
    booking: booking,
    hotel: hotel,
    status: checkoutSession.status,
    customer_email: checkoutSession.customer_details?.email,
    paymentStatus: booking.paymentStatus,
  });
};
