package main

import "example.com/acme/agent/beeper"

func startBeeper() error {
	return beeper.Sync()
}
