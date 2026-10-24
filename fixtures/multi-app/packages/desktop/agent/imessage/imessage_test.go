package imessage

import "testing"

func TestWatch(t *testing.T) {
	if err := Watch(); err != nil {
		t.Fatal(err)
	}
}
